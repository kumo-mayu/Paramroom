// Batchmode test of the local transport probe (graphics required):
//   Unity -batchmode -projectPath <p> -executeMethod ParamroomLocalProbeTest.Run -probeOut <dir> [-probeK 512]
// Builds the prefab, drives its real FX controller with an Animator (as VRChat would, parameters set per frame),
// NOTE: with Animator.Update + Camera.Render called by hand in the editor, a render uses the values of the PREVIOUS
// Update (seen 2026-09-19), so every state that matters is held for two frames.
// renders the loop (camera A then B) and reads the statistics back from the atlas. Checks:
//   1 clean sends: every chunk present and correct, every group taken
//   2 torn between groups (half the groups still hold the previous send): those groups are rejected, nothing wrong written
//   3 torn inside a group (first 16 values new, last 16 old): rejected
//   4 a new session clears the store
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

public static class ParamroomLocalProbeTest
{
    static uint Hash(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
    static float Enc(uint tag, uint payload) => BitConverter.Int32BitsToSingle((int)(((tag & 3) << 28 | (payload & 0x0FFFFFFF)) + 0x00800000u));

    public static void Run()
    {
        var args = Environment.GetCommandLineArgs();
        int oi = Array.IndexOf(args, "-probeOut");
        string outDir = oi >= 0 ? args[oi + 1] : "ProbeOut";
        int ki = Array.IndexOf(args, "-probeK");
        int K = ki >= 0 ? int.Parse(args[ki + 1]) : 512;
        int G = K / 32;
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        void Log(string s) { log.Add(s); Debug.Log("[Probe] " + s); }
        int fails = 0;
        void Check(bool ok, string what) { if (!ok) fails++; Log($"{(ok ? "OK " : "NG ")} {what}"); }
        try
        {
            var prefabPath = ParamroomLocalProbeBuilder.Build(K);
            var root = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath));
            root.transform.position = new Vector3(500, 0, 0);
            var ctrl = AssetDatabase.LoadAssetAtPath<RuntimeAnimatorController>($"Assets/ParamroomLocalProbe/Generated_{K}/ProbeFX.controller");
            var anim = root.AddComponent<Animator>();
            anim.runtimeAnimatorController = ctrl;
            anim.cullingMode = AnimatorCullingMode.AlwaysAnimate;
            anim.Rebind();
            anim.SetBool("IsLocal", true);
            anim.Update(0);
            var camA = root.transform.Find("Loop/CamA").GetComponent<Camera>();
            var camB = root.transform.Find("Loop/CamB").GetComponent<Camera>();
            Check(camA.enabled && camB.enabled, "IsLocal enables the loop cameras");
            var rtA = camA.targetTexture;
            int W = rtA.width, H = rtA.height, ctrlRow = ParamroomLocalProbeBuilder.StoreRows + 1;
            var ids = Enumerable.Range(0, K).Select(i => Animator.StringToHash($"{ParamroomLocalProbeBuilder.Prefix}{i}")).ToArray();

            var swAnim = new Stopwatch(); var swRender = new Stopwatch(); int frames = 0;
            void Frame()
            {
                swAnim.Start(); anim.Update(1f / 60); swAnim.Stop();
                swRender.Start(); camA.Render(); camB.Render(); swRender.Stop();
                frames++;
            }
            int flip = -1;
            uint session = 7;
            uint[] Ctrl()
            {
                var tex = new Texture2D(W, H, TextureFormat.RGBA32, false);
                RenderTexture.active = rtA; tex.ReadPixels(new Rect(0, 0, W, H), 0, 0); tex.Apply(); RenderTexture.active = null;
                var p = tex.GetPixels32(); UnityEngine.Object.DestroyImmediate(tex);
                uint[] Row(int y) => Enumerable.Range(0, 16).Select(x => { var c = p[y * W + x]; return (uint)c.r << 24 | (uint)c.g << 16 | (uint)c.b << 8 | c.a; }).ToArray();
                if (flip < 0) flip = Row(ctrlRow)[9] == session ? 0 : 1;
                return Row(flip == 0 ? ctrlRow : H - 1 - ctrlRow);
            }
            void SetSession(uint s, uint target) { session = s; anim.SetFloat(ParamroomLocalProbeBuilder.SessionParam, s); anim.SetFloat(ParamroomLocalProbeBuilder.TargetParam, target); }
            // one send: group g carries chunk chunkOf(g); tag = send counter
            uint sendNo = 0;
            float[] SendValues(Func<int, int> chunkOf, uint tag)
            {
                var v = new float[K];
                for (int g = 0; g < G; g++)
                {
                    uint c = (uint)chunkOf(g);
                    v[g * 32] = Enc(tag, c);
                    for (int j = 1; j < 32; j++) v[g * 32 + j] = Enc(tag, Hash(c * 32 + (uint)j));
                }
                return v;
            }
            void Apply(float[] v) { for (int i = 0; i < K; i++) anim.SetFloat(ids[i], v[i]); }

            // ---- 1 clean sends: 1024 chunks, one send per frame
            int T = 1024;
            SetSession(7, (uint)T);
            Frame(); Frame();
            int sends = (T + G - 1) / G;
            for (int s = 0; s < sends; s++) { Apply(SendValues(g => Math.Min(s * G + g, T - 1), sendNo++)); Frame(); }
            Frame(); Frame();
            var c1 = Ctrl();
            Log($"after clean: present {c1[1]} correct {c1[2]} taken {c1[3]} rejected {c1[4]} frames {c1[0]} completeFrames {c1[8]} torn {c1[15]}");
            Check(c1[1] == T && c1[2] == T, $"1 clean: all {T} chunks present and correct");
            Check(c1[4] == 0, "1 clean: no group rejected");
            Check(c1[7] != 0 && c1[8] != 0, "1 clean: completion recorded");

            // ---- 2 torn between groups: new session, chunks 0..; each send leaves the second half of the groups at
            // the previous send's values (valid on their own - they are taken as the old chunk, which is correct data)
            SetSession(8, (uint)T);
            Frame(); Frame();
            var c2a = Ctrl();
            Check(c2a[1] == 0, "4 a new session clears the store");
            float[] prev = null;
            for (int s = 0; s < sends; s++)
            {
                var v = SendValues(g => Math.Min(s * G + g, T - 1), sendNo++);
                if (prev != null) { var torn = (float[])v.Clone(); Array.Copy(prev, K / 2, torn, K / 2, K - K / 2); Apply(torn); Frame(); }
                Apply(v); Frame();
                prev = v;
            }
            Frame();
            var c2 = Ctrl();
            Log($"after torn-between: present {c2[1]} correct {c2[2]} taken {c2[3]} rejected {c2[4]}");
            Check(c2[1] == T && c2[2] == T, "2 torn between groups: store still complete and correct");

            // ---- 3 torn inside a group: first 16 values of every group new, last 16 from the previous send
            SetSession(9, (uint)T);
            Frame(); Frame();
            prev = SendValues(g => g, sendNo++); Apply(prev); Frame(); Frame();
            var before = Ctrl();
            var next = SendValues(g => G + g, sendNo++);
            var mix = (float[])next.Clone();
            for (int g = 0; g < G; g++) Array.Copy(prev, g * 32 + 16, mix, g * 32 + 16, 16);
            Apply(mix); Frame(); Frame();
            {
                var mpb = new MaterialPropertyBlock();
                root.transform.Find("Loop/CamA/G0").GetComponent<MeshRenderer>().GetPropertyBlock(mpb);
                uint Bits(float f) => (uint)BitConverter.SingleToInt32Bits(f);
                Log($"debug G0: F0 {Bits(mpb.GetFloat("_F0")):X8} (mix {Bits(mix[0]):X8}) F16 {Bits(mpb.GetFloat("_F16")):X8} (mix {Bits(mix[16]):X8} next {Bits(next[16]):X8} prev {Bits(prev[16]):X8}) animF16 {Bits(anim.GetFloat(ids[16])):X8}");
            }
            var c3 = Ctrl();
            Log($"torn-inside: rejected {c3[4] - before[4]} of {G}, present {c3[1]} (was {before[1]}), correct {c3[2]}");
            Check(c3[4] - before[4] >= G, "3 torn inside a group: every group rejected (held 2 frames: 2G)");
            Check(c3[1] == before[1] && c3[2] == c3[1], "3 torn inside a group: nothing new written, nothing wrong");

            // ---- 5 the test must be able to fail: a same-tag tear (tags do not change) goes undetected by design;
            // with correct data in both halves nothing breaks, but wrong data would be taken. Check the correct flag
            // really catches a wrong payload: send chunk ids whose data belong to another chunk.
            SetSession(10, 16);
            Frame(); Frame();
            var wrong = SendValues(g => g, sendNo++);
            for (int g = 0; g < G; g++) wrong[g * 32] = Enc(sendNo - 1, (uint)(g + 100));   // header says chunk g+100
            Apply(wrong); Frame(); Frame();
            var c5 = Ctrl();
            Check(c5[1] == G && c5[2] == 0, $"5 wrong payload is marked not correct (present {c5[1]}, correct {c5[2]})");

            // ---- 6 the overlay: render it like a 1280x720 screen and save it, for local-probe-read.js
            {
                var hud = root.transform.Find("Hud").gameObject;
                Check(hud.activeSelf, "6 IsLocal shows the overlay");
                Check(Math.Abs(anim.GetFloat(ParamroomLocalProbeBuilder.HudParam) - 1) < 1e-6, "6 overlay parameter defaults to 1");
                anim.Update(1f / 60); anim.Update(1f / 60);
                var shotRt = new RenderTexture(1280, 720, 24, RenderTextureFormat.ARGB32);
                var camGo = new GameObject("shot");
                camGo.transform.position = hud.transform.position + new Vector3(0, 0, -2);
                var cam = camGo.AddComponent<Camera>();
                cam.targetTexture = shotRt; cam.clearFlags = CameraClearFlags.SolidColor; cam.backgroundColor = new Color(0.3f, 0.5f, 0.7f);
                cam.cullingMask = 1 << hud.layer; cam.enabled = false;
                cam.Render();
                var tex = new Texture2D(1280, 720, TextureFormat.RGBA32, false);
                RenderTexture.active = shotRt; tex.ReadPixels(new Rect(0, 0, 1280, 720), 0, 0); tex.Apply(); RenderTexture.active = null;
                File.WriteAllBytes(Path.Combine(outDir, "hud.png"), tex.EncodeToPNG());
                var cw = Ctrl();
                Log("hud words " + string.Join(",", cw));
            }

            Log($"K={K}: Animator.Update {swAnim.Elapsed.TotalMilliseconds / frames:F3} ms/frame, render A+B (CPU, incl. submission) {swRender.Elapsed.TotalMilliseconds / frames:F3} ms/frame over {frames} frames");
        }
        catch (Exception e) { fails++; Log("EXCEPTION " + e); }
        Log(fails == 0 ? "ALL OK" : $"{fails} FAILED");
        File.WriteAllLines(Path.Combine(outDir, "localprobe.txt"), log);
        EditorApplication.Exit(fails == 0 ? 0 : 1);
    }
}
