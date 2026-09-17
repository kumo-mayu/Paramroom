// ImagePad primitive decoder prefab builder (prototype).
//
// Window: Tools/ImagePad/Prim Decoder Builder
//   - pick the decoder format (256/1000, 512/2000, 512/4000) and the number of synced Int parameters D0..D(B-1)
//   - only the "good" Int counts are offered: the smallest count for each number of primitives per packet (more Ints
//     between two good counts would only add padding)
//   - with an avatar selected, shows its synced bits used by everything else (NDMF ParameterInfo, the same source as the
//     Modular Avatar "Parameter Usage" window) and marks which counts fit into the free space
// Menus (32 Int, as before): Tools/ImagePad/Build Prim Decoder Prefab (256 bit[, 512 canvas, 2000|4000])
//
// A prefab contains:
//   - two ARGBHalf atlas RenderTextures, 512x288 / 1024x536 (double-buffered camera loop, see ImagePadPrimDecoder.shader)
//   - loop cameras A/B (disabled, enabled by the FX animation) with full-viewport decoder quads
//   - a display quad (ImagePad/PrimDisplay) showing the decoded image
//   - FX controller: D0..D(B-1) (Float in the animator) -> Direct blend tree -> material._Pi on both decoder quads,
//     plus an always-on base child that writes 0 to every _Pi and enables the cameras
//   - Modular Avatar Merge Animator + Parameters: D0..D(B-1) synced Int, ImagePad_Format local-only Int (format id)
// The sender (tools/ImagePadTool) reads ImagePad_Format and counts D0..D(B-1) with OSCQuery.
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

public static class ImagePadPrimBuilder
{
    const string Root = "Assets/ImagePadMeasure";
    const int LoopLayer = 12;

    // format id (ImagePad_Format) -> canvas, primitives requested (the layout rounds up to whole units)
    public static readonly Dictionary<int, (int canvas, int prims, string name)> Formats = new()
    {
        [1] = (256, 1000, "256/1000"),
        [2] = (512, 2000, "512/2000"),
        [3] = (512, 4000, "512/4000"),
    };

    // ---- layout (same as sim/codecs/prim.js layout / tools/ImagePadTool PrimLayout; rotated ellipses e9.8.6-c565a2)
    public const int PrimBits = 58;
    public struct Layout { public int bytes, u, k, k0, units, maxPrims, spare; }
    public static Layout? LayoutFor(int prims, int bytes)
    {
        int P = 8 * bytes - 2;
        for (int u = 1; u <= 16; u++)
        {
            int pay = P - u;
            if (PrimBits > pay) continue;
            int k = pay / PrimBits, k0 = Math.Max(0, (pay - 16) / PrimBits);
            int maxPrims = k0 + (int)Math.Ceiling(Math.Max(0, prims - k0) / (double)k) * k;
            int units = 1 + (maxPrims - k0) / k;
            if (units <= (1 << u))
            {
                int spare = pay - Math.Max(16 + k0 * PrimBits, k * PrimBits);
                return new Layout { bytes = bytes, u = u, k = k, k0 = k0, units = units, maxPrims = maxPrims, spare = spare };
            }
        }
        return null;
    }
    // smallest Int count for each number of primitives per packet, with a spare byte for the aspect code, <= 32 Ints,
    // <= 4096 stored primitives
    public static List<Layout> GoodLayouts(int prims)
    {
        var list = new List<Layout>();
        int prevK = -1;
        for (int b = 1; b <= 32; b++)
        {
            var l = LayoutFor(prims, b);
            if (l is not Layout L || L.spare < 8 || L.maxPrims > 4096 || L.k == prevK) continue;
            list.Add(L); prevK = L.k;
        }
        return list;
    }

    [MenuItem("Tools/ImagePad/Build Prim Decoder Prefab (256 bit)")]
    public static void Build() => Build(1, 32);

    [MenuItem("Tools/ImagePad/Build Prim Decoder Prefab (256 bit, 512 canvas, 2000)")]
    public static void Build512n2000() => Build(2, 32);

    [MenuItem("Tools/ImagePad/Build Prim Decoder Prefab (256 bit, 512 canvas, 4000)")]
    public static void Build512() => Build(3, 32);

    public static string PrefabName(int formatId, int bytes)
    {
        string baseName = formatId switch { 1 => "ImagePadPrimDecoder", 2 => "ImagePadPrimDecoder512n2000", _ => "ImagePadPrimDecoder512" };
        return bytes == 32 ? baseName : $"{baseName}_{bytes}int";
    }

    // formatId: 1..3 (Formats); bytes: number of synced Int parameters (should be one of GoodLayouts)
    public static string Build(int formatId, int bytes)
    {
        var (canvas, prims, _) = Formats[formatId];
        var layout = LayoutFor(prims, bytes) ?? throw new Exception($"no layout for {prims} primitives in {bytes} Int");
        if (layout.spare < 8) throw new Exception($"{bytes} Int: no spare byte for the aspect code");
        // unique loop camera far planes per format (the quads only draw for their own camera)
        float farA = formatId switch { 1 => 0.0237f, 2 => 0.0257f, _ => 0.0247f }, farB = farA + 0.0002f;
        string prefabName = PrefabName(formatId, bytes);
        string suffix = prefabName.Substring("ImagePadPrimDecoder".Length);
        string Gen = Root + "/GeneratedPrim" + suffix;
        if (!AssetDatabase.IsValidFolder(Gen)) AssetDatabase.CreateFolder(Root, "GeneratedPrim" + suffix);
        T Save<T>(T obj, string name) where T : UnityEngine.Object
        {
            var path = $"{Gen}/{name}";
            if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(path) != null) AssetDatabase.DeleteAsset(path);
            AssetDatabase.CreateAsset(obj, path);
            return obj;
        }
        var decShader = Shader.Find("ImagePad/PrimDecoder");
        var dispShader = Shader.Find("ImagePad/PrimDisplay");
        if (decShader == null || dispShader == null) throw new Exception("ImagePad prim shaders not found");

        RenderTexture Atlas(string name)
        {
            var d = new RenderTextureDescriptor(2 * canvas, canvas + 8192 / (2 * canvas) + 16, RenderTextureFormat.ARGBHalf, 0) { sRGB = false, msaaSamples = 1, useMipMap = false, autoGenerateMips = false };
            return Save(new RenderTexture(d) { name = name, filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp }, name + ".renderTexture");
        }
        var rtA = Atlas("ImagePadPrimAtlasA" + suffix);
        var rtB = Atlas("ImagePadPrimAtlasB" + suffix);
        var matA = Save(new Material(decShader) { name = "ImagePadPrimDecA" }, "ImagePadPrimDecA.mat");
        matA.SetTexture("_Src", rtB); matA.SetFloat("_Far", farA);
        var matB = Save(new Material(decShader) { name = "ImagePadPrimDecB" }, "ImagePadPrimDecB.mat");
        matB.SetTexture("_Src", rtA); matB.SetFloat("_Far", farB);
        var dispMat = Save(new Material(dispShader) { name = "ImagePadPrimDisplay" }, "ImagePadPrimDisplay.mat");
        dispMat.SetTexture("_Atlas", rtA); dispMat.SetFloat("_Canvas", canvas);
        foreach (var m in new[] { matA, matB })
        {
            m.SetFloat("_Canvas", canvas); m.SetFloat("_R", canvas); m.SetFloat("_ByteCount", bytes);
            m.SetFloat("_U", layout.u); m.SetFloat("_K", layout.k); m.SetFloat("_K0", layout.k0); m.SetFloat("_NPrims", layout.maxPrims);
            EditorUtility.SetDirty(m);
        }

        var root = new GameObject(prefabName);
        var quadMesh = Resources.GetBuiltinResource<Mesh>("Quad.fbx");
        var disp = new GameObject("Display");
        disp.transform.SetParent(root.transform, false);
        disp.transform.localPosition = new Vector3(0.5f, 1.3f, 0.45f);
        disp.transform.localRotation = Quaternion.Euler(0, 180, 0);
        disp.transform.localScale = Vector3.one * 0.45f;
        disp.AddComponent<MeshFilter>().sharedMesh = quadMesh;
        var dr = disp.AddComponent<MeshRenderer>();
        dr.sharedMaterial = dispMat;
        dr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off; dr.receiveShadows = false;

        var loop = new GameObject("Loop");
        loop.transform.SetParent(root.transform, false);
        loop.transform.localPosition = new Vector3(0, -4, 0);
        void MakeCam(string name, Vector3 pos, RenderTexture target, Material mat, float far)
        {
            var go = new GameObject(name) { layer = LoopLayer };
            go.transform.SetParent(loop.transform, false);
            go.transform.localPosition = pos;
            var cam = go.AddComponent<Camera>();
            cam.orthographic = true; cam.orthographicSize = 0.01f; cam.nearClipPlane = 0.001f; cam.farClipPlane = far;
            cam.clearFlags = CameraClearFlags.Nothing; cam.cullingMask = 1 << LoopLayer; cam.targetTexture = target;
            cam.allowHDR = false; cam.allowMSAA = false; cam.depth = name == "CamA" ? -101 : -100; cam.enabled = false;
            var q = new GameObject("Quad") { layer = LoopLayer };
            q.transform.SetParent(go.transform, false);
            q.transform.localPosition = new Vector3(0, 0, 0.012f);
            q.transform.localScale = Vector3.one * 0.1f;
            q.AddComponent<MeshFilter>().sharedMesh = quadMesh;
            var r = q.AddComponent<MeshRenderer>();
            r.sharedMaterial = mat; r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off; r.receiveShadows = false;
        }
        MakeCam("CamA", Vector3.zero, rtA, matA, farA);
        MakeCam("CamB", new Vector3(0, 0, 1), rtB, matB, farB);

        // clips
        string[] quads = { "Loop/CamA/Quad", "Loop/CamB/Quad" };
        var children = new List<ChildMotion>();
        AnimationCurve Const(float v) => new AnimationCurve(new Keyframe(0, v), new Keyframe(1f / 60f, v));
        for (int i = 0; i < bytes; i++)
        {
            var clip = new AnimationClip { name = $"ImagePadPrim_Set_P{i}" };
            foreach (var q in quads) AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve(q, typeof(MeshRenderer), $"material._P{i}"), Const(1));
            children.Add(new ChildMotion { motion = Save(clip, clip.name + ".anim"), directBlendParameter = $"D{i}", timeScale = 1 });
        }
        var baseClip = new AnimationClip { name = "ImagePadPrim_Base" };
        foreach (var q in quads) for (int i = 0; i < bytes; i++) AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve(q, typeof(MeshRenderer), $"material._P{i}"), Const(0));
        foreach (var c in new[] { "Loop/CamA", "Loop/CamB" }) AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve(c, typeof(Camera), "m_Enabled"), Const(1));
        children.Add(new ChildMotion { motion = Save(baseClip, baseClip.name + ".anim"), directBlendParameter = "ImagePadPrim_One", timeScale = 1 });

        var ctrlPath = $"{Gen}/ImagePadPrim_FX.controller";
        if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(ctrlPath) != null) AssetDatabase.DeleteAsset(ctrlPath);
        var ctrl = AnimatorController.CreateAnimatorControllerAtPath(ctrlPath);
        for (int i = 0; i < bytes; i++) ctrl.AddParameter($"D{i}", AnimatorControllerParameterType.Float);
        ctrl.AddParameter(new AnimatorControllerParameter { name = "ImagePadPrim_One", type = AnimatorControllerParameterType.Float, defaultFloat = 1 });
        var tree = new BlendTree { name = "ImagePadPrimDirect", blendType = BlendTreeType.Direct, useAutomaticThresholds = false, hideFlags = HideFlags.HideInHierarchy };
        tree.children = children.ToArray();
        AssetDatabase.AddObjectToAsset(tree, ctrl);
        var so = new SerializedObject(tree);
        var norm = so.FindProperty("m_NormalizedBlendValues");
        if (norm != null) { norm.boolValue = false; so.ApplyModifiedPropertiesWithoutUndo(); }
        var sm = ctrl.layers[0].stateMachine;
        var st = sm.AddState("ImagePadPrimRun");
        st.motion = tree; st.writeDefaultValues = true; sm.defaultState = st;
        var layers = ctrl.layers; layers[0].name = "ImagePadPrimDecoder"; layers[0].defaultWeight = 1; ctrl.layers = layers;
        EditorUtility.SetDirty(ctrl);

        ImagePadMeasureBuilder.AddMergeAnimator(root, ctrl);
        ImagePadMeasureBuilder.AddParameters(root, bytes, formatId);
        string prefabPath = $"{Root}/{prefabName}.prefab";
        PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
        UnityEngine.Object.DestroyImmediate(root);
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        Debug.Log($"[ImagePad] built {prefabPath} (format {formatId}, {bytes} Int, u={layout.u} k={layout.k} k0={layout.k0} primitives={layout.maxPrims} units={layout.units})");
        return prefabPath;
    }

    // ---- synced bits of an avatar via NDMF (reflection, so this file compiles without NDMF)
    // returns (bits used by everything except ImagePad decoders, bits used by ImagePad decoders), or null without NDMF
    public static (int others, int imagePad)? SyncedBits(GameObject avatarRoot)
    {
        var t = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("nadena.dev.ndmf.ParameterInfo")).FirstOrDefault(x => x != null);
        if (t == null || avatarRoot == null) return null;
        var forUI = t.GetField("ForUI")?.GetValue(null);
        var get = t.GetMethods().FirstOrDefault(m => m.Name == "GetParametersForObject" && m.GetParameters().Length == 2 && m.GetParameters()[0].ParameterType == typeof(GameObject));
        if (forUI == null || get == null) return null;
        int Bits(GameObject go)
        {
            int sum = 0;
            foreach (var p in (System.Collections.IEnumerable)get.Invoke(forUI, new object[] { go, null }))
                sum += (int)p.GetType().GetProperty("BitUsage").GetValue(p);
            return sum;
        }
        int total = Bits(avatarRoot);
        int imagePad = avatarRoot.GetComponentsInChildren<Transform>(true)
            .Where(tr => tr.name.StartsWith("ImagePadPrimDecoder") && (tr.parent == null || !tr.parent.name.StartsWith("ImagePadPrimDecoder")))
            .Sum(tr => Bits(tr.gameObject));
        return (total - imagePad, imagePad);
    }

    public static void BuildBatch()
    {
        try
        {
            foreach (var f in Formats.Keys)
                foreach (var l in GoodLayouts(Formats[f].prims)) Build(f, l.bytes);
            EditorApplication.Exit(0);
        }
        catch (Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
    }
}

public sealed class ImagePadPrimBuilderWindow : EditorWindow
{
    int formatId = 3;
    int selected = -1;
    Vector2 scroll;

    [MenuItem("Tools/ImagePad/Prim Decoder Builder")]
    static void Open() => GetWindow<ImagePadPrimBuilderWindow>("ImagePad Builder");

    void OnSelectionChange() => Repaint();

    void OnGUI()
    {
        scroll = EditorGUILayout.BeginScrollView(scroll);
        EditorGUILayout.LabelField("フォーマット（キャンバス / 図形数）", EditorStyles.boldLabel);
        var keys = ImagePadPrimBuilder.Formats.Keys.ToArray();
        int fi = Math.Max(0, Array.IndexOf(keys, formatId));
        fi = GUILayout.Toolbar(fi, keys.Select(k => ImagePadPrimBuilder.Formats[k].name).ToArray());
        if (keys[fi] != formatId) { formatId = keys[fi]; selected = -1; }

        // avatar and its free synced bits
        EditorGUILayout.Space();
        var sel = Selection.activeGameObject;
        GameObject avatar = null;
        for (var tr = sel != null ? sel.transform : null; tr != null; tr = tr.parent)
            if (tr.GetComponents<Component>().Any(c => c != null && c.GetType().Name == "VRCAvatarDescriptor")) { avatar = tr.gameObject; break; }
        int? free = null;
        if (avatar == null) EditorGUILayout.HelpBox("ヒエラルキーでアバター（またはその子）を選択すると、空きビット数を表示します。", MessageType.Info);
        else
        {
            var bits = ImagePadPrimBuilder.SyncedBits(avatar);
            if (bits is not { } b) EditorGUILayout.HelpBox("NDMF が見つからないため、使用ビット数を取得できません。", MessageType.Warning);
            else
            {
                free = 256 - b.others;
                EditorGUILayout.LabelField("アバター", avatar.name);
                EditorGUILayout.LabelField("他のギミックの同期ビット", $"{b.others} bit");
                EditorGUILayout.LabelField("ImagePad が使える空き", $"{free} bit（Int {free / 8} 個）");
                if (b.imagePad > 0) EditorGUILayout.LabelField("現在の ImagePad デコーダー", $"{b.imagePad} bit");
            }
        }

        // good Int counts
        EditorGUILayout.Space();
        EditorGUILayout.LabelField("Int の数（図形数 / パケットが変わる数だけ）", EditorStyles.boldLabel);
        var layouts = ImagePadPrimBuilder.GoodLayouts(ImagePadPrimBuilder.Formats[formatId].prims);
        if (selected < 0)
        {
            selected = layouts.Count - 1;
            if (free is int fr) { int best = layouts.FindLastIndex(l => l.bytes * 8 <= fr); if (best >= 0) selected = best; }
        }
        for (int i = 0; i < layouts.Count; i++)
        {
            var l = layouts[i];
            bool fits = free is not int f2 || l.bytes * 8 <= f2;
            string label = $"Int {l.bytes} 個（{l.bytes * 8} bit）: 図形 {l.k} 個/パケット、{l.units} ユニット、1 周 {l.units / 10.0:F0} 秒{(fits ? "" : "  ※空きが足りません")}";
            using (new EditorGUI.DisabledScope(!fits))
                if (EditorGUILayout.ToggleLeft(label, selected == i) && selected != i) selected = i;
        }

        EditorGUILayout.Space();
        if (selected >= 0 && selected < layouts.Count)
        {
            var l = layouts[selected];
            string name = ImagePadPrimBuilder.PrefabName(formatId, l.bytes);
            if (GUILayout.Button($"プレハブを作成: {name}", GUILayout.Height(28)))
            {
                string path = ImagePadPrimBuilder.Build(formatId, l.bytes);
                EditorGUIUtility.PingObject(AssetDatabase.LoadAssetAtPath<GameObject>(path));
            }
            EditorGUILayout.HelpBox("アバターには ImagePad デコーダーを 1 つだけ入れてください。センダーは ImagePad_Format と D0..D" + (l.bytes - 1) + " の数を OSCQuery で読み、自動で合わせます。", MessageType.None);
        }
        EditorGUILayout.EndScrollView();
    }
}
