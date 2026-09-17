// ImagePad prim decoder shader test (batchmode with graphics):
//   Unity -batchmode -projectPath <p> -executeMethod ImagePadPrimTest.Run -imagepadOut <dir> [-imagepadData <TestData json name>]
// Feeds exported prim packets (TestData/<name>.json, from sim/export-prim-test.js) into the PrimDecoder camera loop by
// setting material properties directly (as the FX blend tree would). Each packet is held for several loop steps, as in
// VRChat. Checks:
//   - display canvas == JS reference render (<name>-expected.png), after the first half and after all packets
//   - redraw on change: the loop goes idle (counter 0, dirty 0) and a repeated packet does not start a redraw
//   - display quad aspect (PrimDisplay shader)
//   - timing of drawing steps vs idle steps (one step = both loop cameras)
using System;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;

public static class ImagePadPrimTest
{
    const int Hold = 3; // loop steps per packet

    public static void Run()
    {
        var args = Environment.GetCommandLineArgs();
        int oi = Array.IndexOf(args, "-imagepadOut");
        string outDir = oi >= 0 ? args[oi + 1] : "ImagePadPrimTest";
        int di = Array.IndexOf(args, "-imagepadData");
        string dataName = di >= 0 ? args[di + 1] : "prim-kodim23";
        System.IO.Directory.CreateDirectory(outDir);
        try
        {
            var json = System.IO.File.ReadAllText($"Assets/ImagePadMeasure/TestData/{dataName}.json");
            int Num(string key, string within) => int.Parse(Regex.Match(within, $"\"{key}\":([0-9]+)").Groups[1].Value);
            string layout = json.Substring(json.IndexOf("\"layout\""));
            int U = Num("u", layout), K = Num("k", layout), K0 = Num("k0", layout), NPrims = Num("maxPrims", layout);
            int R = Num("R", json.Substring(json.IndexOf("\"cfg\"")));
            int C = R; // canvas texels = coordinate range (256 or 512)
            int W = 2 * C, H = C + 8192 / W + 16, ctrlY = C + 8192 / W + 8;
            int pi = json.IndexOf("\"packets\"");
            var nums = Regex.Matches(json.Substring(pi), "[0-9]+").Cast<Match>().Select(m => int.Parse(m.Value)).ToList();
            var nbMatch = Regex.Match(json, "\"bytes\":([0-9]+)");
            int NB = nbMatch.Success ? int.Parse(nbMatch.Groups[1].Value) : 32; // synced Int parameters per packet
            int nPackets = nums.Count / NB;
            int nBatches = (NPrims + 31) / 32;

            var shader = Shader.Find("ImagePad/PrimDecoder");
            if (shader == null) throw new Exception("PrimDecoder shader missing");
            RenderTexture MakeAtlas() { var d = new RenderTextureDescriptor(W, H, RenderTextureFormat.ARGBHalf, 0) { sRGB = false }; var rt = new RenderTexture(d) { filterMode = FilterMode.Point }; rt.Create(); return rt; }
            var rtA = MakeAtlas(); var rtB = MakeAtlas();
            var quadMesh = Resources.GetBuiltinResource<Mesh>("Quad.fbx");
            Material matA = new Material(shader), matB = new Material(shader);
            foreach (var m in new[] { matA, matB })
            {
                m.SetFloat("_U", U); m.SetFloat("_K", K); m.SetFloat("_K0", K0); m.SetFloat("_NPrims", NPrims);
                m.SetFloat("_R", R); m.SetFloat("_Canvas", C); m.SetFloat("_ByteCount", NB);
            }
            Camera MakeCam(Vector3 pos, RenderTexture target, Material mat, RenderTexture src, float far)
            {
                var go = new GameObject("primcam") { layer = 12 };
                go.transform.position = pos;
                var cam = go.AddComponent<Camera>();
                cam.orthographic = true; cam.orthographicSize = 0.01f; cam.nearClipPlane = 0.001f; cam.farClipPlane = far;
                cam.clearFlags = CameraClearFlags.Nothing; cam.cullingMask = 1 << 12; cam.targetTexture = target;
                cam.allowHDR = false; cam.allowMSAA = false; cam.enabled = false;
                var q = new GameObject("primquad") { layer = 12 };
                q.transform.SetParent(go.transform, false);
                q.transform.localPosition = new Vector3(0, 0, 0.012f);
                q.transform.localScale = Vector3.one * 0.1f;
                q.AddComponent<MeshFilter>().sharedMesh = quadMesh;
                mat.SetTexture("_Src", src); mat.SetFloat("_Far", far);
                q.AddComponent<MeshRenderer>().sharedMaterial = mat;
                return cam;
            }
            var camA = MakeCam(new Vector3(200, 0, 0), rtA, matA, rtB, 0.0217f);
            var camB = MakeCam(new Vector3(200, 0, 5), rtB, matB, rtA, 0.0219f);
            void SetPacket(int k) { for (int b = 0; b < NB; b++) { float v = nums[k * NB + b]; matA.SetFloat($"_P{b}", v); matB.SetFloat($"_P{b}", v); } }
            void Step() { camA.Render(); camB.Render(); }
            Color[] ReadAtlas()
            {
                var tex = new Texture2D(W, H, TextureFormat.RGBAHalf, false);
                RenderTexture.active = rtA; tex.ReadPixels(new Rect(0, 0, W, H), 0, 0); tex.Apply(); RenderTexture.active = null;
                var p = tex.GetPixels(); UnityEngine.Object.DestroyImmediate(tex); return p;
            }
            // readback index y*W+x = shader texel row y (as in the earlier 256 test)
            Color Ctrl(Color[] p, int x) => p[ctrlY * W + x];

            // expected display (JS render), PNG rows are bottom-up after LoadImage
            var expTex = new Texture2D(2, 2);
            expTex.LoadImage(System.IO.File.ReadAllBytes($"Assets/ImagePadMeasure/TestData/{dataName}-expected.png"));
            var exp = expTex.GetPixels32();
            (int maxDiff, bool flip) Compare(Color[] p)
            {
                int best = int.MaxValue; bool bestFlip = false;
                foreach (bool flip in new[] { false, true })
                {
                    int md = 0;
                    for (int y = 0; y < C; y++)
                        for (int x = 0; x < C; x++)
                        {
                            var c = flip ? p[(H - 1 - y) * W + C + x] : p[y * W + C + x];
                            var e = exp[(C - 1 - y) * C + x];
                            md = Math.Max(md, Math.Max(Math.Abs((int)Mathf.Round(c.r) - e.r), Math.Max(Math.Abs((int)Mathf.Round(c.g) - e.g), Math.Abs((int)Mathf.Round(c.b) - e.b))));
                        }
                    if (md < best) { best = md; bestFlip = flip; }
                }
                return (best, bestFlip);
            }
            void Settle() { for (int s = 0; s < nBatches * 2 + 4; s++) Step(); }

            // phase 1: all packets, each held for Hold steps, then settle
            var sw = System.Diagnostics.Stopwatch.StartNew();
            for (int k = 0; k < nPackets; k++) { SetPacket(k); for (int h = 0; h < Hold; h++) Step(); }
            var probe = new Texture2D(1, 1, TextureFormat.RGBAHalf, false);
            void Sync() { RenderTexture.active = rtA; probe.ReadPixels(new Rect(0, 0, 1, 1), 0, 0); probe.Apply(); RenderTexture.active = null; }
            Sync(); sw.Stop();
            long feedMs = sw.ElapsedMilliseconds;
            // timing: a full redraw right after the last packet (all batches draw)
            var sw2 = System.Diagnostics.Stopwatch.StartNew(); Settle(); Sync(); sw2.Stop();
            var p1 = ReadAtlas();
            var cmp = Compare(p1);
            Debug.Log($"[ImagePad] prim test {dataName}: C={C} R={R} u={U} n={NPrims} batches={nBatches}; packets={nPackets} x hold {Hold}: {feedMs} ms; settle {nBatches * 2 + 4} steps {sw2.ElapsedMilliseconds} ms; display vs expected maxdiff={cmp.maxDiff} (flip {cmp.flip}); counter={Ctrl(p1, 0).r} dirty={Ctrl(p1, 6).r} epoch={Ctrl(p1, 1).r}");

            // idle timing
            var sw3 = System.Diagnostics.Stopwatch.StartNew(); for (int s = 0; s < 120; s++) Step(); Sync(); sw3.Stop();
            // repeated packet must not start a redraw
            SetPacket(nPackets / 2); for (int h = 0; h < Hold; h++) Step();
            var p2 = ReadAtlas();
            Debug.Log($"[ImagePad] prim idle: 120 idle steps {sw3.ElapsedMilliseconds} ms ({sw3.ElapsedMilliseconds / 120.0:F2} ms/step) vs drawing {(double)sw2.ElapsedMilliseconds / (nBatches * 2 + 4):F2} ms/step; after repeated packet counter={Ctrl(p2, 0).r} dirty={Ctrl(p2, 6).r} (expect 0/0)");

            // phase 2: fresh state (epoch 2), first half of packets, go idle, then the rest: display must match again
            void SetEpoch2(int k) { SetPacket(k); float b0 = nums[k * NB] & 0x3F | 0x80; matA.SetFloat("_P0", b0); matB.SetFloat("_P0", b0); }
            for (int k = 0; k < nPackets / 2; k++) { SetEpoch2(k); for (int h = 0; h < Hold; h++) Step(); }
            Settle();
            var p3 = ReadAtlas();
            for (int k = nPackets / 2; k < nPackets; k++) { SetEpoch2(k); for (int h = 0; h < Hold; h++) Step(); }
            Settle();
            var p4 = ReadAtlas();
            var cmp4 = Compare(p4);
            Debug.Log($"[ImagePad] prim split feed: after half counter={Ctrl(p3, 0).r} dirty={Ctrl(p3, 6).r}; after all maxdiff={cmp4.maxDiff} counter={Ctrl(p4, 0).r} dirty={Ctrl(p4, 6).r} epoch={Ctrl(p4, 1).r}");

            // display PNG
            var outTex = new Texture2D(C, C, TextureFormat.RGB24, false);
            var o = new Color32[C * C];
            for (int y = 0; y < C; y++)
                for (int x = 0; x < C; x++)
                {
                    var c = cmp4.flip ? p4[(H - 1 - y) * W + C + x] : p4[y * W + C + x];
                    o[(C - 1 - y) * C + x] = new Color32((byte)Mathf.Clamp(Mathf.Round(c.r), 0, 255), (byte)Mathf.Clamp(Mathf.Round(c.g), 0, 255), (byte)Mathf.Clamp(Mathf.Round(c.b), 0, 255), 255);
                }
            outTex.SetPixels32(o); outTex.Apply();
            System.IO.File.WriteAllBytes(System.IO.Path.Combine(outDir, $"{dataName}-display.png"), outTex.EncodeToPNG());

            // display quad (PrimDisplay shader) seen by an orthographic camera: checks the aspect reshaping
            var dispShader = Shader.Find("ImagePad/PrimDisplay");
            if (dispShader == null) throw new Exception("PrimDisplay shader missing");
            var dispMat = new Material(dispShader); dispMat.SetTexture("_Atlas", rtA); dispMat.SetFloat("_Canvas", C);
            var dq = new GameObject("dispquad") { layer = 13 };
            dq.transform.position = new Vector3(-200, 0, 1);
            dq.AddComponent<MeshFilter>().sharedMesh = quadMesh;
            dq.AddComponent<MeshRenderer>().sharedMaterial = dispMat;
            var viewRt = new RenderTexture(new RenderTextureDescriptor(256, 256, RenderTextureFormat.ARGB32, 16)); viewRt.Create();
            var vgo = new GameObject("viewcam"); vgo.transform.position = new Vector3(-200, 0, 0);
            var vcam = vgo.AddComponent<Camera>();
            vcam.orthographic = true; vcam.orthographicSize = 0.5f; vcam.nearClipPlane = 0.1f; vcam.farClipPlane = 10;
            vcam.clearFlags = CameraClearFlags.SolidColor; vcam.backgroundColor = Color.magenta; vcam.cullingMask = 1 << 13;
            vcam.targetTexture = viewRt; vcam.enabled = false; vcam.Render();
            var view = new Texture2D(256, 256, TextureFormat.RGB24, false);
            RenderTexture.active = viewRt; view.ReadPixels(new Rect(0, 0, 256, 256), 0, 0); view.Apply(); RenderTexture.active = null;
            System.IO.File.WriteAllBytes(System.IO.Path.Combine(outDir, $"{dataName}-view.png"), view.EncodeToPNG());
            int vw = 0, vh = 0;
            for (int x = 0; x < 256; x++) { var c = view.GetPixel(x, 128); if (!(c.r > 0.9f && c.g < 0.1f && c.b > 0.9f)) vw++; }
            for (int y = 0; y < 256; y++) { var c = view.GetPixel(128, y); if (!(c.r > 0.9f && c.g < 0.1f && c.b > 0.9f)) vh++; }
            int present = 0;
            for (int j = 0; j < NPrims; j++)
            {
                int t = 2 * j + 1, sx = t % W, sy = C + t / W;
                var c = p4[sy * W + sx];
                if (((int)Mathf.Round(c.a) & 1) == 1) present++;
            }
            Debug.Log($"[ImagePad] prim view: aspect accepted={Ctrl(p4, 4).r}, quad {vw}x{vh} px (w/h {(float)vw / vh:F3}); present prims={present}/{NPrims}");
            EditorApplication.Exit(0);
        }
        catch (Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
    }
}
