// Paramroom local image - prefab builder (research, docs/research/13).
//
// Window: Tools/Paramroom/Local Image Builder. Batch: ParamroomLocalImageBuilder.BuildBatch -imageK 512
//
// Shows an image sent from the PC on the wearer's OWN client only (local, not synced Float parameters), so that VRChat's
// photo camera can be made to capture it (camera jack) - e.g. to turn it into a Print. Transport = the probe's
// (docs/research/12): K parameters in groups of 32, one self-checking 868-bit chunk per group per send. Image format =
// lpic v1 (sim/local/lpic.js): baseline-JPEG-like DCT, decoded by the loop once every chunk is there.
//
// A prefab contains:
//   - store atlases A/B 256 x 516 ARGB32 (4096 chunks + status row + control row), block map 256 x 192 ARGBFloat,
//     band 1024 x 128 ARGBFloat, image 1024 x 1024 ARGB32 (about 12 MB of render textures)
//   - Loop/CamStoreA (copy + K/32 group quads), CamStoreB (copy + statistics), CamMap, CamIdctV, CamIdctH
//   - Hud (statistics + preview, normal view only) and Jack (the photo camera sees the image), wearer only
//   - FX: Direct blend tree PRL0..PRL{K-1} -> material._F{i%32} of group i/32, PRS -> CamStoreB quad _Session,
//     PRH -> Hud _Show, PRJ -> Jack _Jack, plus a base child writing 0 to all of them; layer 2 turns the cameras and
//     the overlays on when IsLocal
//   - Modular Avatar: Merge Animator (FX) + Parameters (all Float, local only, not saved; PRH defaults to 1)
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

public static class ParamroomLocalImageBuilder
{
    const string Root = "Assets/ParamroomLocalImage";
    const int LoopLayer = 12;
    public const int StoreW = 256, StoreRows = 512, StoreH = StoreRows + 4, ImageSize = 1024;
    public const string Prefix = "PRL", SessionParam = "PRS", HudParam = "PRH", JackParam = "PRJ";
    public static readonly (string name, float far, int depth)[] Cams =
    {
        ("CamStoreA", 0.0417f, -131), ("CamStoreB", 0.0419f, -130), ("CamMap", 0.0421f, -129), ("CamIdctV", 0.0423f, -128), ("CamIdctH", 0.0425f, -127),
    };

    public static string Build(int k)
    {
        if (k % 32 != 0 || k < 32 || k > 8192) throw new Exception("K must be a multiple of 32 in 32..8192");
        int groups = k / 32;
        if (groups > StoreW) throw new Exception("too many groups for the status row");
        string name = $"ParamroomLocalImage_{k}";
        string gen = $"{Root}/Generated_{k}";
        if (!AssetDatabase.IsValidFolder(gen)) AssetDatabase.CreateFolder(Root, $"Generated_{k}");
        T Save<T>(T obj, string file) where T : UnityEngine.Object
        {
            var path = $"{gen}/{file}";
            if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(path) != null) AssetDatabase.DeleteAsset(path);
            AssetDatabase.CreateAsset(obj, path);
            return obj;
        }
        Shader Find(string n) => Shader.Find(n) ?? throw new Exception($"shader {n} not found");
        RenderTexture Rt(string n, int w, int h, RenderTextureFormat f, FilterMode filter)
        {
            var d = new RenderTextureDescriptor(w, h, f, 0) { sRGB = false, msaaSamples = 1, useMipMap = false, autoGenerateMips = false };
            return Save(new RenderTexture(d) { name = n, filterMode = filter, wrapMode = TextureWrapMode.Clamp }, n + ".renderTexture");
        }
        var storeA = Rt("LocalStoreA", StoreW, StoreH, RenderTextureFormat.ARGB32, FilterMode.Point);
        var storeB = Rt("LocalStoreB", StoreW, StoreH, RenderTextureFormat.ARGB32, FilterMode.Point);
        var map = Rt("LocalBlockMap", 256, 192, RenderTextureFormat.ARGBFloat, FilterMode.Point);
        var band = Rt("LocalBand", ImageSize, 128, RenderTextureFormat.ARGBFloat, FilterMode.Point);
        var image = Rt("LocalImage", ImageSize, ImageSize, RenderTextureFormat.ARGB32, FilterMode.Bilinear);

        Material Mat(string shader, string n, Action<Material> set)
        {
            var m = Save(new Material(Find(shader)) { name = n }, n + ".mat");
            set(m); EditorUtility.SetDirty(m);
            return m;
        }
        var matA = Mat("Paramroom/LocalImageLoop", "LocalLoopA", m => { m.SetTexture("_Src", storeB); m.SetFloat("_Far", Cams[0].far); m.SetFloat("_Primary", 1); m.SetFloat("_Groups", groups); });
        var matB = Mat("Paramroom/LocalImageLoop", "LocalLoopB", m => { m.SetTexture("_Src", storeA); m.SetFloat("_Far", Cams[1].far); m.SetFloat("_Primary", 0); m.SetFloat("_Groups", groups); });
        var matMap = Mat("Paramroom/LocalImageBlockMap", "LocalBlockMap", m => { m.SetTexture("_Store", storeB); m.SetFloat("_Far", Cams[2].far); });
        var matV = Mat("Paramroom/LocalImageIdctV", "LocalIdctV", m => { m.SetTexture("_Store", storeB); m.SetTexture("_BlockMap", map); m.SetFloat("_Far", Cams[3].far); });
        var matH = Mat("Paramroom/LocalImageIdctH", "LocalIdctH", m => { m.SetTexture("_Store", storeB); m.SetTexture("_Band", band); m.SetFloat("_Far", Cams[4].far); m.SetFloat("_ImageSize", ImageSize); });
        var matHud = Mat("Paramroom/LocalImageHud", "LocalHud", m => { m.SetTexture("_Store", storeB); m.SetTexture("_Image", image); m.SetFloat("_ImageSize", ImageSize); });
        var matJack = Mat("Paramroom/LocalImageJack", "LocalJack", m => { m.SetTexture("_Store", storeB); m.SetTexture("_Image", image); m.SetFloat("_ImageSize", ImageSize); });
        var groupShader = Find("Paramroom/LocalImageGroup");

        var groupMesh = new Mesh { name = "LocalGroupMesh" };
        groupMesh.vertices = new[] { new Vector3(-.5f, -.5f), new Vector3(.5f, -.5f), new Vector3(-.5f, .5f), new Vector3(.5f, .5f),
                                     new Vector3(-.5f, -.5f), new Vector3(.5f, -.5f), new Vector3(-.5f, .5f), new Vector3(.5f, .5f) };
        groupMesh.uv = new[] { new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 1), new Vector2(1, 1),
                               new Vector2(0, 2), new Vector2(1, 2), new Vector2(0, 3), new Vector2(1, 3) };
        groupMesh.triangles = new[] { 0, 2, 1, 1, 2, 3, 4, 6, 5, 5, 6, 7 };
        groupMesh.bounds = new Bounds(Vector3.zero, Vector3.one * 2);
        Save(groupMesh, "LocalGroupMesh.asset");
        var overlayMesh = new Mesh { name = "LocalOverlayMesh" };
        overlayMesh.vertices = new[] { new Vector3(-.5f, -.5f), new Vector3(.5f, -.5f), new Vector3(-.5f, .5f), new Vector3(.5f, .5f) };
        overlayMesh.uv = new[] { new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 1), new Vector2(1, 1) };
        overlayMesh.triangles = new[] { 0, 2, 1, 1, 2, 3 };
        overlayMesh.bounds = new Bounds(Vector3.zero, Vector3.one * 10000);
        Save(overlayMesh, "LocalOverlayMesh.asset");
        var quadMesh = Resources.GetBuiltinResource<Mesh>("Quad.fbx");

        var root = new GameObject(name);
        MeshRenderer Renderer(GameObject go, Mesh mesh, Material mat)
        {
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            var r = go.AddComponent<MeshRenderer>();
            r.sharedMaterial = mat; r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off; r.receiveShadows = false;
            r.lightProbeUsage = UnityEngine.Rendering.LightProbeUsage.Off; r.reflectionProbeUsage = UnityEngine.Rendering.ReflectionProbeUsage.Off;
            return r;
        }
        foreach (var (n, m) in new[] { ("Hud", matHud), ("Jack", matJack) })
        {
            var go = new GameObject(n);
            go.transform.SetParent(root.transform, false);
            go.transform.localPosition = new Vector3(0, 1.5f, 0);
            Renderer(go, overlayMesh, m);
            go.SetActive(false);
        }
        var loop = new GameObject("Loop");
        loop.transform.SetParent(root.transform, false);
        loop.transform.localPosition = new Vector3(0, -4, 0);
        var targets = new[] { storeA, storeB, map, band, image };
        var mats = new[] { matA, matB, matMap, matV, matH };
        GameObject camStoreA = null;
        for (int c = 0; c < Cams.Length; c++)
        {
            var go = new GameObject(Cams[c].name) { layer = LoopLayer };
            go.transform.SetParent(loop.transform, false);
            go.transform.localPosition = new Vector3(0, 0, c);
            var cam = go.AddComponent<Camera>();
            cam.orthographic = true; cam.orthographicSize = 0.01f; cam.nearClipPlane = 0.001f; cam.farClipPlane = Cams[c].far;
            cam.clearFlags = CameraClearFlags.Nothing; cam.cullingMask = 1 << LoopLayer; cam.targetTexture = targets[c];
            cam.allowHDR = false; cam.allowMSAA = false; cam.depth = Cams[c].depth; cam.enabled = false;
            var q = new GameObject("Quad") { layer = LoopLayer };
            q.transform.SetParent(go.transform, false);
            q.transform.localPosition = new Vector3(0, 0, 0.012f);
            q.transform.localScale = Vector3.one * 0.1f;
            Renderer(q, quadMesh, mats[c]);
            if (c == 0) camStoreA = go;
        }
        for (int g = 0; g < groups; g++)
        {
            var q = new GameObject($"G{g}") { layer = LoopLayer };
            q.transform.SetParent(camStoreA.transform, false);
            q.transform.localPosition = new Vector3(0, 0, 0.012f);
            q.transform.localScale = Vector3.one * 0.01f;
            var m = Save(new Material(groupShader) { name = $"LocalGroup{g}" }, $"LocalGroup{g}.mat");
            m.SetFloat("_Far", Cams[0].far); m.SetFloat("_AtlasW", StoreW); m.SetFloat("_AtlasH", StoreH); m.SetFloat("_StoreRows", StoreRows); m.SetFloat("_Group", g);
            Renderer(q, groupMesh, m);
        }

        // ---- FX
        AnimationCurve Const(float v) => new AnimationCurve(new Keyframe(0, v), new Keyframe(1f / 60f, v));
        var clips = new List<(AnimationClip clip, string param)>();
        var baseClip = new AnimationClip { name = "LocalBase" };
        void Bind(string param, string path, string prop)
        {
            var c = new AnimationClip { name = $"Local_{param}" };
            AnimationUtility.SetEditorCurve(c, EditorCurveBinding.FloatCurve(path, typeof(MeshRenderer), prop), Const(1));
            AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve(path, typeof(MeshRenderer), prop), Const(0));
            clips.Add((c, param));
        }
        for (int i = 0; i < k; i++) Bind($"{Prefix}{i}", $"Loop/CamStoreA/G{i / 32}", $"material._F{i % 32}");
        Bind(SessionParam, "Loop/CamStoreB/Quad", "material._Session");
        Bind(HudParam, "Hud", "material._Show");
        Bind(JackParam, "Jack", "material._Jack");
        var ctrlPath = $"{gen}/LocalImageFX.controller";
        if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(ctrlPath) != null) AssetDatabase.DeleteAsset(ctrlPath);
        var ctrl = AnimatorController.CreateAnimatorControllerAtPath(ctrlPath);
        foreach (var (_, p) in clips) ctrl.AddParameter(new AnimatorControllerParameter { name = p, type = AnimatorControllerParameterType.Float, defaultFloat = p == HudParam ? 1 : 0 });
        ctrl.AddParameter(new AnimatorControllerParameter { name = "LocalOne", type = AnimatorControllerParameterType.Float, defaultFloat = 1 });
        ctrl.AddParameter("IsLocal", AnimatorControllerParameterType.Bool);
        foreach (var (c, _) in clips) AssetDatabase.AddObjectToAsset(c, ctrl);
        AssetDatabase.AddObjectToAsset(baseClip, ctrl);
        var tree = new BlendTree { name = "LocalDirect", blendType = BlendTreeType.Direct, useAutomaticThresholds = false, hideFlags = HideFlags.HideInHierarchy };
        tree.children = clips.Select(c => new ChildMotion { motion = c.clip, directBlendParameter = c.param, timeScale = 1 })
            .Append(new ChildMotion { motion = baseClip, directBlendParameter = "LocalOne", timeScale = 1 }).ToArray();
        AssetDatabase.AddObjectToAsset(tree, ctrl);
        var so = new SerializedObject(tree);
        var norm = so.FindProperty("m_NormalizedBlendValues");
        if (norm != null) { norm.boolValue = false; so.ApplyModifiedPropertiesWithoutUndo(); }
        var sm = ctrl.layers[0].stateMachine;
        var run = sm.AddState("LocalRun"); run.motion = tree; run.writeDefaultValues = true; sm.defaultState = run;
        ctrl.AddLayer("LocalImageGate");
        var layers = ctrl.layers;
        layers[0].name = "LocalImageData"; layers[0].defaultWeight = 1; layers[1].defaultWeight = 1;
        ctrl.layers = layers;
        var onClip = new AnimationClip { name = "LocalOn" };
        var offClip = new AnimationClip { name = "LocalOff" };
        foreach (var (clip, v) in new[] { (onClip, 1f), (offClip, 0f) })
        {
            foreach (var cam in Cams) AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve($"Loop/{cam.name}", typeof(Camera), "m_Enabled"), Const(v));
            foreach (var o in new[] { "Hud", "Jack" }) AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve(o, typeof(GameObject), "m_IsActive"), Const(v));
            AssetDatabase.AddObjectToAsset(clip, ctrl);
        }
        var gsm = ctrl.layers[1].stateMachine;
        var off = gsm.AddState("Remote"); off.motion = offClip; off.writeDefaultValues = true;
        var on = gsm.AddState("Local"); on.motion = onClip; on.writeDefaultValues = true;
        gsm.defaultState = off;
        var toOn = off.AddTransition(on); toOn.hasExitTime = false; toOn.duration = 0; toOn.AddCondition(AnimatorConditionMode.If, 0, "IsLocal");
        var toOff = on.AddTransition(off); toOff.hasExitTime = false; toOff.duration = 0; toOff.AddCondition(AnimatorConditionMode.IfNot, 0, "IsLocal");
        EditorUtility.SetDirty(ctrl);

        AddMergeAnimator(root, ctrl);
        AddParameters(root, clips.Select(c => c.param).ToList());
        string prefabPath = $"{Root}/{name}.prefab";
        PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
        UnityEngine.Object.DestroyImmediate(root);
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        Debug.Log($"[LocalImage] built {prefabPath} (K={k}, groups={groups}, {clips.Count} parameters)");
        return prefabPath;
    }

    static Type FindType(string fullName) =>
        AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(fullName, false)).FirstOrDefault(t => t != null);

    static void AddMergeAnimator(GameObject root, RuntimeAnimatorController ctrl)
    {
        var t = FindType("nadena.dev.modular_avatar.core.ModularAvatarMergeAnimator");
        if (t == null) { Debug.LogWarning("[LocalImage] Modular Avatar not found: add the FX controller manually."); return; }
        var so = new SerializedObject(root.AddComponent(t));
        so.FindProperty("animator").objectReferenceValue = ctrl;
        var enumType = FindType("VRC.SDK3.Avatars.Components.VRCAvatarDescriptor+AnimLayerType");
        so.FindProperty("layerType").intValue = enumType != null ? (int)Enum.Parse(enumType, "FX") : 5;
        so.FindProperty("pathMode").intValue = 0;
        so.FindProperty("deleteAttachedAnimator").boolValue = true;
        so.FindProperty("matchAvatarWriteDefaults").boolValue = false;
        so.ApplyModifiedPropertiesWithoutUndo();
    }

    // all Float, local only (in the expression parameters so OSC can write them, 0 synced bits), not saved
    static void AddParameters(GameObject root, List<string> names)
    {
        var t = FindType("nadena.dev.modular_avatar.core.ModularAvatarParameters");
        if (t == null) { Debug.LogWarning("[LocalImage] Modular Avatar not found: add the parameters manually."); return; }
        var so = new SerializedObject(root.AddComponent(t));
        var list = so.FindProperty("parameters");
        var syncEnum = FindType("nadena.dev.modular_avatar.core.ParameterSyncType");
        int floatSync = syncEnum != null ? (int)Enum.Parse(syncEnum, "Float") : 2;
        list.arraySize = names.Count;
        for (int i = 0; i < names.Count; i++)
        {
            var el = list.GetArrayElementAtIndex(i);
            el.FindPropertyRelative("nameOrPrefix").stringValue = names[i];
            el.FindPropertyRelative("remapTo").stringValue = "";
            el.FindPropertyRelative("internalParameter").boolValue = false;
            el.FindPropertyRelative("isPrefix").boolValue = false;
            el.FindPropertyRelative("syncType").intValue = floatSync;
            el.FindPropertyRelative("localOnly").boolValue = true;
            bool on = names[i] == HudParam;
            el.FindPropertyRelative("defaultValue").floatValue = on ? 1 : 0;
            var hasDef = el.FindPropertyRelative("hasExplicitDefaultValue");
            if (hasDef != null) hasDef.boolValue = on;
            el.FindPropertyRelative("saved").boolValue = false;
        }
        so.ApplyModifiedPropertiesWithoutUndo();
    }

    public static void BuildBatch()
    {
        var args = Environment.GetCommandLineArgs();
        int i = Array.IndexOf(args, "-imageK");
        foreach (var k in i >= 0 ? args[i + 1].Split(',').Select(int.Parse) : new[] { 512 }) Build(k);
        EditorApplication.Exit(0);
    }
}

public class ParamroomLocalImageWindow : EditorWindow
{
    int k = 512;
    [MenuItem("Tools/Paramroom/Local Image Builder")]
    static void Open() => GetWindow<ParamroomLocalImageWindow>("Local Image");
    void OnGUI()
    {
        EditorGUILayout.HelpBox("研究用（docs/research/13）。PC の画像を自分のアバターにだけ送り、写真カメラに写すプレハブを作ります。\n" +
            "パラメータはすべて同期しない Float です（同期ビットは使いません）。カメラと表示は着ている本人にだけ出ます。", MessageType.Info);
        k = EditorGUILayout.IntPopup("パラメータ数 K", k, new[] { "256", "512", "1024" }, new[] { 256, 512, 1024 });
        if (GUILayout.Button("作る")) EditorGUIUtility.PingObject(AssetDatabase.LoadAssetAtPath<GameObject>(ParamroomLocalImageBuilder.Build(k)));
    }
}
