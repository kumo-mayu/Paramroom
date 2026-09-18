// QR 専用プレハブが実際に作れることを確かめる（batchmode）:
//   Unity -batchmode -projectPath <p> -executeMethod ParamroomQrBuildTest.Run
// ビルダーを呼び、出来たプレハブの中身（カメラ 2 つ・表示板・マテリアルの値・Modular Avatar の
// パラメータ）を見る。プレハブ生成は Unity の中でしか動かないので、ここでしか確かめられない。
using System;
using System.Linq;
using UnityEditor;
using UnityEngine;

public static class ParamroomQrBuildTest
{
    public static void Run()
    {
        int bad = 0;
        void Check(bool ok, string what) { Debug.Log($"[QrBuildTest] {(ok ? "OK" : "NG")} {what}"); if (!ok) bad++; }
        try
        {
            foreach (int bytes in new[] { 3, 4, 8, 16 })
            {
                var L = ParamroomBuilder.QrLayoutFor(bytes);
                if (L is not ParamroomBuilder.QrLayout l) { Check(false, $"{bytes} Int の割り付けが無い"); continue; }
                string path = ParamroomBuilder.BuildQr(bytes);
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                Check(prefab != null, $"{bytes} Int: プレハブが出来た（{path}）");
                if (prefab == null) continue;

                var cams = prefab.GetComponentsInChildren<Camera>(true);
                Check(cams.Length == 2, $"{bytes} Int: カメラ 2 つ（{cams.Length}）");
                Check(cams.All(c => c.targetTexture != null && !c.enabled), $"{bytes} Int: カメラに RT が付いていて、既定では止まっている");
                Check(cams.Select(c => c.farClipPlane).Distinct().Count() == 2, $"{bytes} Int: A と B の far が違う");

                var rends = prefab.GetComponentsInChildren<MeshRenderer>(true);
                Check(rends.Length == 3, $"{bytes} Int: 表示板 1 ＋ ループ用 2 = 3 枚（{rends.Length}）");
                var decMats = rends.Select(r => r.sharedMaterial).Where(m => m != null && m.shader.name == "Paramroom/QrDecoder").ToArray();
                Check(decMats.Length == 2, $"{bytes} Int: デコーダーのマテリアル 2 つ");
                Check(decMats.All(m => Mathf.Approximately(m.GetFloat("_U"), l.u) && Mathf.Approximately(m.GetFloat("_Pay"), l.pay) && Mathf.Approximately(m.GetFloat("_ByteCount"), bytes)),
                    $"{bytes} Int: マテリアルに u={l.u} pay={l.pay} ByteCount={bytes} が入っている");
                var dispMat = rends.Select(r => r.sharedMaterial).FirstOrDefault(m => m != null && m.shader.name == "Paramroom/QrDisplay");
                Check(dispMat != null && Mathf.Approximately(dispMat.GetFloat("_MaxSide"), ParamroomBuilder.QrMaxSide), $"{bytes} Int: 表示板のマテリアル");

                // Modular Avatar のパラメータ（リフレクション越しに付けているので、数だけ見る）
                var pars = prefab.GetComponentsInChildren<Component>(true).FirstOrDefault(c => c != null && c.GetType().Name == "ModularAvatarParameters");
                Check(pars != null, $"{bytes} Int: Modular Avatar の Parameters が付いている");
                if (pars != null)
                {
                    var so = new SerializedObject(pars);
                    var list = so.FindProperty("parameters");
                    // D0..D(n-1) ＋ Paramroom_Format
                    Check(list != null && list.arraySize == bytes + 1, $"{bytes} Int: パラメータ {bytes + 1} 個（{list?.arraySize}）");
                }
                var merge = prefab.GetComponentsInChildren<Component>(true).FirstOrDefault(c => c != null && c.GetType().Name == "ModularAvatarMergeAnimator");
                Check(merge != null, $"{bytes} Int: Modular Avatar の Merge Animator が付いている");
            }
            Debug.Log($"[QrBuildTest] {(bad == 0 ? "すべて OK" : bad + " 件 NG")}");
        }
        catch (Exception e) { Debug.LogError("[QrBuildTest] " + e); bad++; }
        EditorApplication.Exit(bad == 0 ? 0 : 1);
    }
}
