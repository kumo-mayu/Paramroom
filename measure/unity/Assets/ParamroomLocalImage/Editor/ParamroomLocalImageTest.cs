// Batchmode test of the local image prefab (graphics required):
//   Unity -batchmode -projectPath <p> -executeMethod ParamroomLocalImageTest.Run -imageOut <dir> [-imageData kodim23-q50]
// Builds the prefab (K = 512), drives its real FX controller with an Animator, sends the chunks of an lpic file
// (TestData/<name>.lpic.json from sim/local/lpic.js) one send per two frames (in the editor a render uses the values of
// the previous Animator.Update, see ParamroomLocalProbeTest), lets the loop decode, and checks:
//   1 every chunk present, completion and decode recorded
//   2 the decoded image equals the reference decode (<name>-expected.png): max difference <= 1 (float rounding)
//   3 with one chunk missing nothing is decoded
//   4 the camera jack: a 1920x1080 "photo" (_VRChatCameraMode = 2) shows the image letterboxed, upright, same colours
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

public static class ParamroomLocalImageTest
{
    static float Enc(uint tag, uint payload) => BitConverter.Int32BitsToSingle((int)(((tag & 3) << 28 | (payload & 0x0FFFFFFF)) + 0x00800000u));

    static Color32[] Read(RenderTexture rt)
    {
        var tex = new Texture2D(rt.width, rt.height, TextureFormat.RGBA32, false);
        RenderTexture.active = rt; tex.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0); tex.Apply(); RenderTexture.active = null;
        var p = tex.GetPixels32(); UnityEngine.Object.DestroyImmediate(tex);
        return p;
    }

    public static void Run()
    {
        var args = Environment.GetCommandLineArgs();
        string Arg(string k, string d) { int i = Array.IndexOf(args, k); return i >= 0 ? args[i + 1] : d; }
        string outDir = Arg("-imageOut", "LocalImageOut"), dataName = Arg("-imageData", "kodim23-q50");
        int K = int.Parse(Arg("-imageK", "512")), G = K / 32;
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        void Log(string s) { log.Add(s); Debug.Log("[LocalImage] " + s); }
        int fails = 0;
        void Check(bool ok, string what) { if (!ok) fails++; Log($"{(ok ? "OK " : "NG ")} {what}"); }
        try
        {
            var json = File.ReadAllText($"Assets/ParamroomLocalImage/TestData/{dataName}.lpic.json");
            int W = int.Parse(Regex.Match(json, "\"w\":([0-9]+)").Groups[1].Value), H = int.Parse(Regex.Match(json, "\"h\":([0-9]+)").Groups[1].Value);
            var nums = Regex.Matches(json.Substring(json.IndexOf("\"chunks\"")), "[0-9]+").Cast<Match>().Select(m => uint.Parse(m.Value)).ToList();
            int N = nums.Count / 31;
            uint[] Chunk(int c) => nums.Skip(c * 31).Take(31).ToArray();
            Log($"{dataName}: {W}x{H}, {N} chunks");

            var prefabPath = ParamroomLocalImageBuilder.Build(K);
            var root = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath));
            root.transform.position = new Vector3(500, 0, 0);
            var anim = root.AddComponent<Animator>();
            anim.runtimeAnimatorController = AssetDatabase.LoadAssetAtPath<RuntimeAnimatorController>($"Assets/ParamroomLocalImage/Generated_{K}/LocalImageFX.controller");
            anim.cullingMode = AnimatorCullingMode.AlwaysAnimate;
            anim.Rebind(); anim.SetBool("IsLocal", true); anim.Update(0);
            var cams = ParamroomLocalImageBuilder.Cams.Select(c => root.transform.Find($"Loop/{c.name}").GetComponent<Camera>()).ToArray();
            Check(cams.All(c => c.enabled), "IsLocal enables the loop cameras");
            var storeB = cams[1].targetTexture; var image = cams[4].targetTexture;
            var ids = Enumerable.Range(0, K).Select(i => Animator.StringToHash($"{ParamroomLocalImageBuilder.Prefix}{i}")).ToArray();
            var swDecode = new Stopwatch(); int frames = 0;
            uint session = 0, sendNo = 0;
            void Frame(bool time = false) { anim.Update(1f / 60); if (time) swDecode.Start(); foreach (var c in cams) c.Render(); if (time) swDecode.Stop(); frames++; }
            uint[] Ctrl()
            {
                var p = Read(storeB);
                int w = storeB.width, row = ParamroomLocalImageBuilder.StoreRows + 1;
                uint[] Row(int y) => Enumerable.Range(0, 16).Select(x => { var c = p[y * w + x]; return (uint)c.r << 24 | (uint)c.g << 16 | (uint)c.b << 8 | c.a; }).ToArray();
                var a = Row(row); var b = Row(storeB.height - 1 - row);
                return a[9] == session ? a : b;
            }

            void Send(IList<int> chunkIds)
            {
                var v = new float[K];
                for (int g = 0; g < G && g < chunkIds.Count; g++)
                {
                    var words = Chunk(chunkIds[g]);
                    v[g * 32] = Enc(sendNo, (uint)chunkIds[g]);
                    for (int j = 1; j < 32; j++) v[g * 32 + j] = Enc(sendNo, words[j - 1]);
                }
                sendNo++;
                for (int i = 0; i < K; i++) anim.SetFloat(ids[i], v[i]);
                Frame(); Frame();
            }
            void Zero() { for (int i = 0; i < K; i++) anim.SetFloat(ids[i], 0); }
            void SendAll(Func<int, bool> skip)
            {
                var order = Enumerable.Range(0, N).Where(c => !skip(c)).ToList();
                for (int s = 0; s < order.Count; s += G) Send(order.Skip(s).Take(G).ToList());
                Zero();
            }

            // ---- 1, 2
            session = 11; anim.SetFloat(ParamroomLocalImageBuilder.SessionParam, session);
            Frame(); Frame();
            SendAll(c => false);
            int bands = (H + 127) / 128;
            for (int f = 0; f < 2 * (bands + 1) + 6; f++) Frame(true);
            var c1 = Ctrl();
            Log($"control: frames {c1[0]} present {c1[1]} total {c1[2]} taken {c1[3]} rejected {c1[4]} completeFrame {c1[8]} size {c1[10] >> 16}x{c1[10] & 0xFFFF} decoded {c1[11]}");
            Check(c1[1] == N && c1[2] == N, $"1 all {N} chunks present, header says {c1[2]}");
            Check(c1[8] != 0 && c1[11] != 0, "1 completion and decode recorded");
            Check(c1[10] == ((uint)W << 16 | (uint)H), "1 size from the header");

            var exp = new Texture2D(2, 2);
            exp.LoadImage(File.ReadAllBytes($"Assets/ParamroomLocalImage/TestData/{dataName}-expected.png"));
            var e = exp.GetPixels32(); // bottom-up rows
            var img = Read(image);
            int S = image.width;
            (int max, int over1, bool flip) Compare(Color32[] got)
            {
                var best = (max: int.MaxValue, over1: 0, flip: false);
                foreach (bool flip in new[] { false, true })
                {
                    int md = 0, o1 = 0;
                    for (int y = 0; y < H; y++)
                        for (int x = 0; x < W; x++)
                        {
                            var g = got[(flip ? S - 1 - y : y) * S + x];     // image texel row y (top origin)
                            var ex = e[(H - 1 - y) * W + x];
                            int d = Math.Max(Math.Abs(g.r - ex.r), Math.Max(Math.Abs(g.g - ex.g), Math.Abs(g.b - ex.b)));
                            md = Math.Max(md, d); if (d > 1) o1++;
                        }
                    if (md < best.max) best = (md, o1, flip);
                }
                return best;
            }
            var cmp = Compare(img);
            Log($"image vs reference: max diff {cmp.max}, pixels off by more than 1: {cmp.over1} of {W * H} (readback flipped: {cmp.flip})");
            Check(cmp.max <= 1, "2 decoded image equals the reference decode (max diff <= 1)");
            Log($"decode frames: {2 * (bands + 1) + 6} (CPU wall incl. GPU sync {swDecode.Elapsed.TotalMilliseconds:F0} ms)");
            {
                // save what the shader made, top row first
                var t = new Texture2D(W, H, TextureFormat.RGBA32, false);
                var px = new Color32[W * H];
                for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) px[(H - 1 - y) * W + x] = img[(cmp.flip ? S - 1 - y : y) * S + x];
                t.SetPixels32(px); t.Apply();
                File.WriteAllBytes(Path.Combine(outDir, $"{dataName}-shader.png"), t.EncodeToPNG());
            }

            // ---- 3 one chunk missing: nothing decoded
            session = 12; anim.SetFloat(ParamroomLocalImageBuilder.SessionParam, session);
            Frame(); Frame();
            SendAll(c => c == N / 2);
            for (int f = 0; f < 10; f++) Frame();
            var c3 = Ctrl();
            Check(c3[1] == N - 1 && c3[8] == 0 && c3[11] == 0, $"3 one chunk missing: present {c3[1]}, not complete, not decoded");
            // the missing chunk arrives: complete and decoded
            Send(new[] { N / 2 }); Zero();
            for (int f = 0; f < 2 * (bands + 1) + 6; f++) Frame();
            var c3b = Ctrl();
            Check(c3b[1] == N && c3b[11] != 0 && Compare(Read(image)).max <= 1, "3 the last chunk completes and decodes the same picture");

            // ---- 4 camera jack
            {
                anim.SetFloat(ParamroomLocalImageBuilder.JackParam, 1); Frame(); Frame();
                var jack = root.transform.Find("Jack").gameObject;
                var shot = new RenderTexture(1920, 1080, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
                var camGo = new GameObject("photo"); camGo.transform.position = jack.transform.position + new Vector3(0, 0, -2);
                var cam = camGo.AddComponent<Camera>();
                cam.targetTexture = shot; cam.clearFlags = CameraClearFlags.SolidColor; cam.backgroundColor = Color.magenta; cam.cullingMask = 1 << jack.layer; cam.enabled = false;
                Shader.SetGlobalFloat("_VRChatCameraMode", 2);
                cam.Render();
                Shader.SetGlobalFloat("_VRChatCameraMode", 0);
                var p = Read(shot);   // bottom-up rows
                var t = new Texture2D(1920, 1080, TextureFormat.RGBA32, false); t.SetPixels32(p); t.Apply();
                File.WriteAllBytes(Path.Combine(outDir, $"{dataName}-jack.png"), t.EncodeToPNG());
                float scale = Math.Min(1920f / W, 1080f / H);
                float ox = (1920 - W * scale) / 2, oy = (1080 - H * scale) / 2;
                // sample image pixels at a few places (top-left origin) and compare with the reference
                int worst = 0, magenta = 0;
                foreach (var (fx, fy) in new[] { (0.25f, 0.2f), (0.5f, 0.5f), (0.75f, 0.8f), (0.1f, 0.9f), (0.9f, 0.1f) })
                {
                    int ix = (int)(fx * W), iy = (int)(fy * H);
                    int sx = (int)(ox + (ix + 0.5f) * scale), syTop = (int)(oy + (iy + 0.5f) * scale);
                    var g = p[(1080 - 1 - syTop) * 1920 + sx];
                    if (g.r == 255 && g.g == 0 && g.b == 255) magenta++;
                    // the photo scales the image with bilinear filtering: compare with the reference sampled the same way
                    // (texel centres, on the stored sRGB bytes), so an edge in a screenshot does not count as an error
                    float px = (sx + 0.5f - ox) / scale - 0.5f, py = (syTop + 0.5f - oy) / scale - 0.5f;
                    int x0 = (int)Math.Floor(px), y0 = (int)Math.Floor(py);
                    float fx0 = px - x0, fy0 = py - y0;
                    Color32 R(int x, int y) => e[(H - 1 - Math.Min(H - 1, Math.Max(0, y))) * W + Math.Min(W - 1, Math.Max(0, x))];
                    float Bil(Func<Color32, byte> ch) => (1 - fy0) * ((1 - fx0) * ch(R(x0, y0)) + fx0 * ch(R(x0 + 1, y0))) + fy0 * ((1 - fx0) * ch(R(x0, y0 + 1)) + fx0 * ch(R(x0 + 1, y0 + 1)));
                    int best = (int)Math.Round(Math.Max(Math.Abs(g.r - Bil(c => c.r)), Math.Max(Math.Abs(g.g - Bil(c => c.g)), Math.Abs(g.b - Bil(c => c.b)))));
                    worst = Math.Max(worst, best);
                }
                Log($"jack: worst colour difference at 5 points {worst} (reference sampled bilinearly), background visible {magenta}");
                Check(magenta == 0 && worst <= 3, "4 the photo shows the image upright with its colours");
                var corner = p[(1080 - 1) * 1920 + 0];
                Check(ox < 1 || (corner.r == 0 && corner.g == 0 && corner.b == 0), "4 letterbox is black");
            }
        }
        catch (Exception ex) { fails++; Log("EXCEPTION " + ex); }
        Log(fails == 0 ? "ALL OK" : $"{fails} FAILED");
        File.WriteAllLines(Path.Combine(outDir, "localimage.txt"), log);
        EditorApplication.Exit(fails == 0 ? 0 : 1);
    }
}
