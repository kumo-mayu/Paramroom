// Paramroom primitive decoder prefab builder (prototype).
//
// Window: Tools/Paramroom/Decoder Builder
//   - pick the decoder format (512/4000, light 512/4000, light 512/5000, 1024/4000) and the number of synced Int
//     parameters D0..D(B-1)
//   - only the "good" Int counts are offered: the smallest count for each number of primitives per packet (more Ints
//     between two good counts would only add padding)
//   - with an avatar selected, shows its synced bits used by everything else (NDMF ParameterInfo, the same source as the
//     Modular Avatar "Parameter Usage" window) and marks which counts fit into the free space
//
// A prefab contains:
//   - two ARGBHalf atlas RenderTextures, 512x288 / 1024x536 / 2048x1044 (double-buffered camera loop, see ParamroomDecoder.shader)
//   - loop cameras A/B (disabled, enabled by the FX animation) with full-viewport decoder quads
//   - a display quad (Paramroom/Display) showing the decoded image
//   - FX controller: D0..D(B-1) (Float in the animator) -> Direct blend tree -> material._Pi on both decoder quads,
//     plus an always-on base child that writes 0 to every _Pi and enables the cameras
//   - Modular Avatar Merge Animator + Parameters: D0..D(B-1) synced Int, Paramroom_Format local-only Int (format id)
// The sender (tools/ParamroomTool) reads Paramroom_Format and counts D0..D(B-1) with OSCQuery.
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

public static class ParamroomBuilder
{
    const string Root = "Assets/Paramroom";
    const int LoopLayer = 12;

    // format id (Paramroom_Format) -> canvas, primitives requested (the layout rounds up to whole units) and the bits of
    // each primitive field. Must match tools/Paramroom.Core DecoderFormat.Known. The light formats (47 bit, 5 primitives in
    // 32 Int) look nearly the same as 58 bit (measure/results/2026-09-17/precision).
    public sealed class Format
    {
        public int canvas, prims, cb, rb, ab, cr, cg, cbl, abits;
        public int batch = 32;   // primitives drawn per pass (per frame); lower = lighter frames, longer redraw
        public string name, prefab;
        public float far;  // unique loop camera far plane per format
        public int PrimBits => 2 * cb + 2 * rb + ab + cr + cg + cbl + abits;
        // the store keeps one primitive in a 64 bit slot whose last bit marks "this one has arrived", so the fields
        // must fit in 63 bits. Without this check a wider format would silently overwrite that mark.
        public void Check() { if (PrimBits > 63) throw new Exception($"{name}: 1 図形 {PrimBits} bit は 63 bit を超えています"); }
    }
    // Formats 1 (256/1000) and 2 (512/2000) are no longer built (2026-09-17: 512 canvas with 4000+ primitives is the base);
    // the sender still supports avatars that have them.
    public static readonly Dictionary<int, Format> Formats = new()
    {
        [3] = new Format { canvas = 512, prims = 4000, cb = 9, rb = 8, ab = 6, cr = 5, cg = 6, cbl = 5, abits = 2, name = "512/4000", prefab = "ParamroomDecoder512", far = 0.0247f },
        [4] = new Format { canvas = 512, prims = 4000, cb = 8, rb = 6, ab = 5, cr = 4, cg = 4, cbl = 4, abits = 2, name = "512/4000 軽量", prefab = "ParamroomDecoder512Light", far = 0.0267f },
        [5] = new Format { canvas = 512, prims = 5000, cb = 8, rb = 6, ab = 5, cr = 4, cg = 4, cbl = 4, abits = 2, name = "512/5000 軽量", prefab = "ParamroomDecoder512Light5000", far = 0.0277f },
        // 1024 canvas (docs/research/08 §17): coordinates need 10 bits, so the angle drops to 5 to keep the primitive at
        // 59 bits and leave the packet 8 spare bits for the aspect code. Made to measure the GPU cost in VRChat: the
        // decoder quad is 2048x1044 instead of 1024x536, so one pass costs about 4x what it does at 512.
        [6] = new Format { canvas = 1024, prims = 4000, cb = 10, rb = 8, ab = 5, cr = 5, cg = 6, cbl = 5, abits = 2, name = "1024/4000（負荷測定用）", prefab = "ParamroomDecoder1024", far = 0.0287f },
    };

    // ---- layout (same as sim/codecs/prim.js layout / tools/Paramroom.Core PrimLayout)
    public struct Layout { public int bytes, u, k, k0, units, maxPrims, spare; }
    public static Layout? LayoutFor(Format f, int bytes)
    {
        int P = 8 * bytes - 2, primBits = f.PrimBits;
        for (int u = 1; u <= 16; u++)
        {
            int pay = P - u;
            if (primBits > pay) continue;
            int k = pay / primBits, k0 = Math.Max(0, (pay - 16) / primBits);
            int maxPrims = k0 + (int)Math.Ceiling(Math.Max(0, f.prims - k0) / (double)k) * k;
            int units = 1 + (maxPrims - k0) / k;
            if (units <= (1 << u))
            {
                int spare = pay - Math.Max(16 + k0 * primBits, k * primBits);
                return new Layout { bytes = bytes, u = u, k = k, k0 = k0, units = units, maxPrims = maxPrims, spare = spare };
            }
        }
        return null;
    }
    // smallest Int count for each number of primitives per packet, with a spare byte for the aspect code, <= 32 Ints
    public static List<Layout> GoodLayouts(Format f)
    {
        var list = new List<Layout>();
        int prevK = -1;
        for (int b = 1; b <= 32; b++)
        {
            var l = LayoutFor(f, b);
            if (l is not Layout L || L.spare < 8 || L.k == prevK) continue;
            list.Add(L); prevK = L.k;
        }
        return list;
    }

    // primitive store texels, whole atlas rows (2C wide), at least 8192 so the atlases of the earlier formats keep their size
    public static int StoreTexels(Format f, Layout l)
    {
        int w = 2 * f.canvas;
        return Math.Max(8192, (2 * l.maxPrims + w - 1) / w * w);
    }

    public static string PrefabName(int formatId, int bytes) => bytes == 32 ? Formats[formatId].prefab : $"{Formats[formatId].prefab}_{bytes}int";

    // formatId: Formats key; bytes: number of synced Int parameters (should be one of GoodLayouts)
    public static string Build(int formatId, int bytes)
    {
        var fmt = Formats[formatId];
        fmt.Check();
        int canvas = fmt.canvas;
        var layout = LayoutFor(fmt, bytes) ?? throw new Exception($"no layout for {fmt.prims} primitives in {bytes} Int");
        if (layout.spare < 8) throw new Exception($"{bytes} Int: no spare byte for the aspect code");
        int storeTexels = StoreTexels(fmt, layout);
        float farA = fmt.far, farB = farA + 0.0002f;
        string prefabName = PrefabName(formatId, bytes);
        string suffix = prefabName.Substring("ParamroomDecoder".Length);
        string Gen = Root + "/GeneratedPrim" + suffix;
        if (!AssetDatabase.IsValidFolder(Gen)) AssetDatabase.CreateFolder(Root, "GeneratedPrim" + suffix);
        T Save<T>(T obj, string name) where T : UnityEngine.Object
        {
            var path = $"{Gen}/{name}";
            if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(path) != null) AssetDatabase.DeleteAsset(path);
            AssetDatabase.CreateAsset(obj, path);
            return obj;
        }
        var decShader = Shader.Find("Paramroom/Decoder");
        var dispShader = Shader.Find("Paramroom/Display");
        if (decShader == null || dispShader == null) throw new Exception("Paramroom prim shaders not found");

        RenderTexture Atlas(string name)
        {
            // store rows: the same ceiling the shader uses (InitLayout: STORE_ROWS = ceil(_StoreTexels / ATLAS_W)).
            // Rounding down here would put the control row outside the texture whenever the two disagree.
            int storeRows = (storeTexels + 2 * canvas - 1) / (2 * canvas);
            var d = new RenderTextureDescriptor(2 * canvas, canvas + storeRows + 16, RenderTextureFormat.ARGBHalf, 0) { sRGB = false, msaaSamples = 1, useMipMap = false, autoGenerateMips = false };
            return Save(new RenderTexture(d) { name = name, filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp }, name + ".renderTexture");
        }
        var rtA = Atlas("ParamroomAtlasA" + suffix);
        var rtB = Atlas("ParamroomAtlasB" + suffix);
        var matA = Save(new Material(decShader) { name = "ParamroomDecA" }, "ParamroomDecA.mat");
        matA.SetTexture("_Src", rtB); matA.SetFloat("_Far", farA);
        var matB = Save(new Material(decShader) { name = "ParamroomDecB" }, "ParamroomDecB.mat");
        matB.SetTexture("_Src", rtA); matB.SetFloat("_Far", farB);
        var dispMat = Save(new Material(dispShader) { name = "ParamroomDisplay" }, "ParamroomDisplay.mat");
        dispMat.SetTexture("_Atlas", rtA); dispMat.SetFloat("_Canvas", canvas); dispMat.SetFloat("_StoreTexels", storeTexels);
        foreach (var m in new[] { matA, matB })
        {
            m.SetFloat("_Canvas", canvas); m.SetFloat("_R", canvas); m.SetFloat("_ByteCount", bytes);
            m.SetFloat("_U", layout.u); m.SetFloat("_K", layout.k); m.SetFloat("_K0", layout.k0); m.SetFloat("_NPrims", layout.maxPrims);
            m.SetFloat("_StoreTexels", storeTexels);
            // written to BOTH materials: the A and B passes must agree on how many primitives a pass draws,
            // otherwise their redraw counters run at different lengths and the picture never completes
            m.SetFloat("_BatchSize", fmt.batch);
            m.SetFloat("_CB", fmt.cb); m.SetFloat("_RB", fmt.rb); m.SetFloat("_AB", fmt.ab);
            m.SetFloat("_CR", fmt.cr); m.SetFloat("_CG", fmt.cg); m.SetFloat("_CBL", fmt.cbl); m.SetFloat("_ABITS", fmt.abits);
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
            var clip = new AnimationClip { name = $"Paramroom_Set_P{i}" };
            foreach (var q in quads) AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve(q, typeof(MeshRenderer), $"material._P{i}"), Const(1));
            children.Add(new ChildMotion { motion = Save(clip, clip.name + ".anim"), directBlendParameter = ParamroomNames.Data(i), timeScale = 1 });
        }
        var baseClip = new AnimationClip { name = "Paramroom_Base" };
        foreach (var q in quads) for (int i = 0; i < bytes; i++) AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve(q, typeof(MeshRenderer), $"material._P{i}"), Const(0));
        foreach (var c in new[] { "Loop/CamA", "Loop/CamB" }) AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve(c, typeof(Camera), "m_Enabled"), Const(1));
        children.Add(new ChildMotion { motion = Save(baseClip, baseClip.name + ".anim"), directBlendParameter = "Paramroom_One", timeScale = 1 });

        var ctrlPath = $"{Gen}/Paramroom_FX.controller";
        if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(ctrlPath) != null) AssetDatabase.DeleteAsset(ctrlPath);
        var ctrl = AnimatorController.CreateAnimatorControllerAtPath(ctrlPath);
        for (int i = 0; i < bytes; i++) ctrl.AddParameter(ParamroomNames.Data(i), AnimatorControllerParameterType.Float);
        ctrl.AddParameter(new AnimatorControllerParameter { name = "Paramroom_One", type = AnimatorControllerParameterType.Float, defaultFloat = 1 });
        var tree = new BlendTree { name = "ParamroomDirect", blendType = BlendTreeType.Direct, useAutomaticThresholds = false, hideFlags = HideFlags.HideInHierarchy };
        tree.children = children.ToArray();
        AssetDatabase.AddObjectToAsset(tree, ctrl);
        var so = new SerializedObject(tree);
        var norm = so.FindProperty("m_NormalizedBlendValues");
        if (norm != null) { norm.boolValue = false; so.ApplyModifiedPropertiesWithoutUndo(); }
        var sm = ctrl.layers[0].stateMachine;
        var st = sm.AddState("ParamroomRun");
        st.motion = tree; st.writeDefaultValues = true; sm.defaultState = st;
        var layers = ctrl.layers; layers[0].name = "Paramroom"; layers[0].defaultWeight = 1; ctrl.layers = layers;
        EditorUtility.SetDirty(ctrl);

        ParamroomModularAvatar.AddMergeAnimator(root, ctrl);
        ParamroomModularAvatar.AddParameters(root, bytes, formatId);
        string prefabPath = $"{Root}/{prefabName}.prefab";
        PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
        UnityEngine.Object.DestroyImmediate(root);
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        Debug.Log($"[Paramroom] built {prefabPath} (format {formatId} {fmt.name}, {fmt.PrimBits} bit, {bytes} Int, u={layout.u} k={layout.k} k0={layout.k0} primitives={layout.maxPrims} units={layout.units} store={storeTexels})");
        return prefabPath;
    }

    // ---- synced bits of an avatar via NDMF (reflection, so this file compiles without NDMF)
    // returns (bits used by everything except Paramroom decoders, bits used by Paramroom decoders), or null without NDMF
    public static (int others, int paramroom)? SyncedBits(GameObject avatarRoot)
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
        int paramroom = avatarRoot.GetComponentsInChildren<Transform>(true)
            .Where(tr => tr.name.StartsWith("ParamroomDecoder") && (tr.parent == null || !tr.parent.name.StartsWith("ParamroomDecoder")))
            .Sum(tr => Bits(tr.gameObject));
        return (total - paramroom, paramroom);
    }

    public static void BuildBatch()
    {
        try
        {
            foreach (var f in Formats.Keys)
                foreach (var l in GoodLayouts(Formats[f])) Build(f, l.bytes);
            EditorApplication.Exit(0);
        }
        catch (Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
    }
}

public sealed class ParamroomBuilderWindow : EditorWindow
{
    int formatId = 3;
    int selected = -1;
    Vector2 scroll;

    [MenuItem("Tools/Paramroom/Decoder Builder")]
    static void Open() => GetWindow<ParamroomBuilderWindow>("Paramroom Builder");

    void OnSelectionChange() => Repaint();

    void OnGUI()
    {
        scroll = EditorGUILayout.BeginScrollView(scroll);
        EditorGUILayout.LabelField("フォーマット（キャンバス / 図形数）", EditorStyles.boldLabel);
        var keys = ParamroomBuilder.Formats.Keys.ToArray();
        int fi = Math.Max(0, Array.IndexOf(keys, formatId));
        fi = GUILayout.SelectionGrid(fi, keys.Select(k => ParamroomBuilder.Formats[k].name).ToArray(), 3);
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
            var bits = ParamroomBuilder.SyncedBits(avatar);
            if (bits is not { } b) EditorGUILayout.HelpBox("NDMF が見つからないため、使用ビット数を取得できません。", MessageType.Warning);
            else
            {
                free = 256 - b.others;
                EditorGUILayout.LabelField("アバター", avatar.name);
                EditorGUILayout.LabelField("他のギミックの同期ビット", $"{b.others} bit");
                EditorGUILayout.LabelField("Paramroom が使える空き", $"{free} bit（Int {free / 8} 個）");
                if (b.paramroom > 0) EditorGUILayout.LabelField("現在の Paramroom デコーダー", $"{b.paramroom} bit");
            }
        }

        // good Int counts
        EditorGUILayout.Space();
        EditorGUILayout.LabelField("Int の数（図形数 / パケットが変わる数だけ）", EditorStyles.boldLabel);
        var layouts = ParamroomBuilder.GoodLayouts(ParamroomBuilder.Formats[formatId]);
        EditorGUILayout.LabelField($"図形 1 個 {ParamroomBuilder.Formats[formatId].PrimBits} bit" + (formatId >= 4 ? "（軽量：座標・色の精度を少し落とし、1 パケットに多く詰める）" : ""));
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
            string name = ParamroomBuilder.PrefabName(formatId, l.bytes);
            if (GUILayout.Button($"プレハブを作成: {name}", GUILayout.Height(28)))
            {
                string path = ParamroomBuilder.Build(formatId, l.bytes);
                EditorGUIUtility.PingObject(AssetDatabase.LoadAssetAtPath<GameObject>(path));
            }
            EditorGUILayout.HelpBox("アバターには Paramroom デコーダーを 1 つだけ入れてください。センダーは Paramroom_Format と D0..D" + (l.bytes - 1) + " の数を OSCQuery で読み、自動で合わせます。", MessageType.None);
        }
        EditorGUILayout.EndScrollView();
    }
}
