// Paramroom QR-only decoder shader test (batchmode with graphics):
//   Unity -batchmode -projectPath <p> -executeMethod ParamroomQrShaderTest.Run -paramroomOut <dir> [-paramroomData <TestData json name>]
// Feeds the packets exported by sim/export-qronly-test.js into the QrDecoder camera loop by setting material
// properties directly (as the FX blend tree would), and checks the cell grid in the atlas. Checks:
//   - after every packet, the grid equals the original QR code (including the three corners, which are NOT sent:
//     the shader draws them from the version alone)
//   - part way through, cells whose packet has not arrived are white, and the corners are already drawn
//   - a new epoch clears the grid
using System;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;

public static class ParamroomQrShaderTest
{
    const int Hold = 3;   // loop steps per packet

    public static void Run()
    {
        var args = Environment.GetCommandLineArgs();
        int oi = Array.IndexOf(args, "-paramroomOut");
        string outDir = oi >= 0 ? args[oi + 1] : "ParamroomQrShaderTest";
        int di = Array.IndexOf(args, "-paramroomData");
        string dataName = di >= 0 ? args[di + 1] : "qronly-25x25-4int";
        System.IO.Directory.CreateDirectory(outDir);
        int bad = 0;
        void Check(bool ok, string what) { Debug.Log($"[QrShaderTest] {(ok ? "OK" : "NG")} {what}"); if (!ok) bad++; }
        try
        {
            string json = System.IO.File.ReadAllText($"Assets/ParamroomMeasure/TestData/{dataName}.json");
            int Num(string key, string within) => int.Parse(Regex.Match(within, $"\"{key}\":([0-9]+)").Groups[1].Value);
            string lay = json.Substring(json.IndexOf("\"layout\""));
            int U = Num("u", lay), Pay = Num("pay", lay);
            int n = Num("modules", json), NB = Num("bytes", json), M = Num("maxSide", json);
            string grid = Regex.Match(json, "\"grid\":\"([01]+)\"").Groups[1].Value;
            var unitOf = Regex.Match(json, "\"unitOf\":\\[([-0-9,]+)\\]").Groups[1].Value.Split(',').Select(int.Parse).ToArray();
            int pi = json.IndexOf("\"packets\"");
            var nums = Regex.Matches(json.Substring(pi), "[0-9]+").Cast<Match>().Select(m => int.Parse(m.Value)).ToList();
            int nPackets = nums.Count / NB;
            int W = 64, H = M + 1, ctrlY = M;

            var shader = Shader.Find("Paramroom/QrDecoder");
            if (shader == null) throw new Exception("Paramroom/QrDecoder shader missing");
            RenderTexture MakeAtlas() { var d = new RenderTextureDescriptor(W, H, RenderTextureFormat.ARGB32, 0) { sRGB = false }; var rt = new RenderTexture(d) { filterMode = FilterMode.Point }; rt.Create(); return rt; }
            var rtA = MakeAtlas(); var rtB = MakeAtlas();
            var quadMesh = Resources.GetBuiltinResource<Mesh>("Quad.fbx");
            Material matA = new Material(shader), matB = new Material(shader);
            foreach (var m in new[] { matA, matB })
            {
                m.SetFloat("_ByteCount", NB); m.SetFloat("_U", U); m.SetFloat("_Pay", Pay); m.SetFloat("_MaxSide", M);
            }
            // 半端パケットを弾く判定をするのは A のパスだけ（docs/research/10）
            matA.SetFloat("_Primary", 1); matB.SetFloat("_Primary", 0);
            Camera MakeCam(Vector3 pos, RenderTexture target, Material mat, RenderTexture src, float far)
            {
                var go = new GameObject("qrcam") { layer = 12 };
                go.transform.position = pos;
                var cam = go.AddComponent<Camera>();
                cam.orthographic = true; cam.orthographicSize = 0.01f; cam.nearClipPlane = 0.001f; cam.farClipPlane = far;
                cam.clearFlags = CameraClearFlags.Nothing; cam.cullingMask = 1 << 12; cam.targetTexture = target;
                cam.allowHDR = false; cam.allowMSAA = false; cam.enabled = false;
                var q = new GameObject("qrquad") { layer = 12 };
                q.transform.SetParent(go.transform, false);
                q.transform.localPosition = new Vector3(0, 0, 0.012f);
                q.transform.localScale = Vector3.one * 0.1f;
                q.AddComponent<MeshFilter>().sharedMesh = quadMesh;
                mat.SetTexture("_Src", src); mat.SetFloat("_Far", far);
                q.AddComponent<MeshRenderer>().sharedMaterial = mat;
                return cam;
            }
            var camA = MakeCam(new Vector3(300, 0, 0), rtA, matA, rtB, 0.0297f);
            var camB = MakeCam(new Vector3(300, 0, 5), rtB, matB, rtA, 0.0299f);
            void SetPacket(int k, int epochOverride = -1)
            {
                for (int b = 0; b < NB; b++)
                {
                    float v = nums[k * NB + b];
                    if (b == 0 && epochOverride >= 0) v = (float)((((int)v) & 0x3F) | (epochOverride << 6));
                    matA.SetFloat($"_P{b}", v); matB.SetFloat($"_P{b}", v);
                }
            }
            void Step() { camA.Render(); camB.Render(); }
            Color[] ReadAtlas()
            {
                var tex = new Texture2D(W, H, TextureFormat.RGBA32, false);
                RenderTexture.active = rtA; tex.ReadPixels(new Rect(0, 0, W, H), 0, 0); tex.Apply(); RenderTexture.active = null;
                var p = tex.GetPixels(); UnityEngine.Object.DestroyImmediate(tex);
                for (int i = 0; i < p.Length; i++) p[i] *= 255;   // ARGB32: 0..1 で入っているので 0..255 に戻す
                return p;
            }
            bool Black(Color[] p, int x, int y) => p[y * W + x].r > 0.5f;

            // ---- part way through: only the packets sent so far, plus the corners the shader draws
            int half = Math.Max(1, nPackets / 2);
            for (int k = 0; k < half; k++) { SetPacket(k); for (int s = 0; s < Hold; s++) Step(); }
            var mid = ReadAtlas();
            int wrongEarly = 0, cornersDrawn = 0, laterWhite = 0, laterCells = 0;
            for (int y = 0; y < n; y++)
                for (int x = 0; x < n; x++)
                {
                    bool want = grid[y * n + x] == '1', got = Black(mid, x, y);
                    int unit = unitOf[y * n + x];
                    if (unit < 0) { if (got == want) cornersDrawn++; else wrongEarly++; }        // corner: drawn from the start
                    else if (unit < half) { if (got != want) wrongEarly++; }                      // arrived: must match
                    else { laterCells++; if (!got) laterWhite++; }                                // not yet: must be white
                }
            Check(wrongEarly == 0, $"途中経過: 届いたマスと切り出しパターンが一致（食い違い {wrongEarly}）");
            Check(cornersDrawn == 3 * 8 * 8, $"切り出しパターンを受信側が描いた（{cornersDrawn}/192 マス）");
            Check(laterWhite == laterCells, $"まだ届いていないマスは白（{laterWhite}/{laterCells}）");

            // ---- everything arrived
            for (int k = half; k < nPackets; k++) { SetPacket(k); for (int s = 0; s < Hold; s++) Step(); }
            var all = ReadAtlas();
            int wrong = 0;
            for (int y = 0; y < n; y++)
                for (int x = 0; x < n; x++)
                    if (Black(all, x, y) != (grid[y * n + x] == '1')) wrong++;
            Check(wrong == 0, $"全部届いた後、元の QR と一致（食い違い {wrong} / {n * n} マス）");
            Check(Math.Abs(all[ctrlY * W + 1].r - (n - 17) / 4) < 0.01f, $"制御行に版が入っている（{all[ctrlY * W + 1].r}）");

            // ---- 半端パケット（docs/research/10）: 前半が新しいパケット・後半が古いパケットという値を
            // 1 フレームだけ見せる。受信側はこれを取り込んではいけない。
            void SetMixed(int newK, int oldK, int frontBytes)
            {
                for (int b = 0; b < NB; b++)
                {
                    float v = nums[(b < frontBytes ? newK : oldK) * NB + b];
                    matA.SetFloat($"_P{b}", v); matB.SetFloat($"_P{b}", v);
                }
            }
            var before = ReadAtlas();
            for (int mix = 1; mix < NB; mix++)
            {
                SetMixed(0, nPackets - 1, mix);
                Step();                      // 1 フレームだけ（VRChat で見える半端な値の持続と同じ）
            }
            SetPacket(nPackets - 1); Step();  // 正しいパケットに戻るが、まだ 1 フレーム目
            var afterTorn = ReadAtlas();
            int changed = 0;
            for (int y = 0; y < n; y++) for (int x = 0; x < n; x++) if (Black(afterTorn, x, y) != Black(before, x, y)) changed++;
            Check(changed == 0, $"半端パケットを取り込まなかった（変わったマス {changed}）");

            // ---- a new epoch clears the grid
            SetPacket(nPackets - 1, 2);          // epoch 2, last unit: nothing else can be placed yet
            for (int s = 0; s < Hold; s++) Step();
            var after = ReadAtlas();
            int leftover = 0;
            for (int y = 0; y < n; y++) for (int x = 0; x < n; x++) if (Black(after, x, y)) leftover++;
            Check(leftover == 0, $"epoch が変わると白紙に戻る（残り {leftover} マス）");

            // 目で見る用: 最後の状態を PNG にしておく
            var shot = new Texture2D(n, n, TextureFormat.RGB24, false);
            for (int y = 0; y < n; y++)
                for (int x = 0; x < n; x++)
                {
                    var c = Black(all, x, y) ? Color.black : Color.white;
                    shot.SetPixel(x, n - 1 - y, c);                 // PNG は下から上
                }
            shot.Apply();
            System.IO.File.WriteAllBytes(System.IO.Path.Combine(outDir, dataName + "-shader.png"), shot.EncodeToPNG());

            Debug.Log($"[QrShaderTest] {dataName}: {(bad == 0 ? "すべて OK" : bad + " 件 NG")}");
        }
        catch (Exception e) { Debug.LogError("[QrShaderTest] " + e); bad++; }
        EditorApplication.Exit(bad == 0 ? 0 : 1);
    }
}
