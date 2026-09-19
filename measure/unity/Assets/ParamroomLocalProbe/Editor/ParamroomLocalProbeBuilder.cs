// Paramroom local transport probe - prefab builder (research, docs/research/12).
//
// Window: Tools/Paramroom/Local Probe Builder. Batch: ParamroomLocalProbeBuilder.BuildBatch -probeK 512
//
// The probe measures how much data VRChat can move from an OSC sender into the wearer's OWN avatar through local
// (not synced) Float parameters: K parameters in groups of 32, each group a self-checking chunk of 868 bits
// (ParamroomLocalGroup.shader). Nothing is synced: remote players never receive these values, and the loop cameras and
// the overlay are only enabled for the wearer (IsLocal).
//
// A prefab contains:
//   - two ARGB32 atlases 256 x 260 (camera loop, store for 2048 chunks + status row + control row)
//   - Loop/CamA (copy quad + K/32 group quads), Loop/CamB (copy + statistics quad)
//   - Hud: screen overlay of the statistics (read back from a screenshot by measure/osc/local-probe-read.js)
//   - FX: layer 0 Direct blend tree (PRL0..PRL{K-1} -> material._F{i%32} of group i/32, PRS/PRT -> CamB quad,
//     PRH -> Hud), plus a base child writing 0 to all of them; layer 1 turns the cameras and the overlay on when IsLocal
//   - Modular Avatar: Merge Animator (FX) + Parameters (PRL*, PRS, PRT, PRH: Float, local only, not saved)
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

public static class ParamroomLocalProbeBuilder
{
    const string Root = "Assets/ParamroomLocalProbe";
    const int LoopLayer = 12;
    public const int AtlasW = 256, StoreRows = 256, AtlasH = StoreRows + 4;
    const float FarA = 0.0317f, FarB = 0.0319f;   // unique loop camera far planes (the image decoders use 0.02x)
    public const string Prefix = "PRL";           // data parameters PRL0.. (short: the OSC address is sent K times per send)
    public const string SessionParam = "PRS", TargetParam = "PRT", HudParam = "PRH";

    public static string Build(int k)
    {
        if (k % 32 != 0 || k < 32 || k > 8192) throw new Exception("K must be a multiple of 32 in 32..8192");
        int groups = k / 32;
        if (groups > AtlasW) throw new Exception("too many groups for the status row");
        string name = $"ParamroomLocalProbe_{k}";
        string gen = $"{Root}/Generated_{k}";
        if (!AssetDatabase.IsValidFolder(gen)) AssetDatabase.CreateFolder(Root, $"Generated_{k}");
        T Save<T>(T obj, string file) where T : UnityEngine.Object
        {
            var path = $"{gen}/{file}";
            if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(path) != null) AssetDatabase.DeleteAsset(path);
            AssetDatabase.CreateAsset(obj, path);
            return obj;
        }
        var loopShader = Shader.Find("Paramroom/LocalLoop");
        var groupShader = Shader.Find("Paramroom/LocalGroup");
        var hudShader = Shader.Find("Paramroom/LocalHud");
        if (loopShader == null || groupShader == null || hudShader == null) throw new Exception("probe shaders not found");

        RenderTexture Atlas(string n)
        {
            var d = new RenderTextureDescriptor(AtlasW, AtlasH, RenderTextureFormat.ARGB32, 0) { sRGB = false, msaaSamples = 1, useMipMap = false, autoGenerateMips = false };
            return Save(new RenderTexture(d) { name = n, filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp }, n + ".renderTexture");
        }
        var rtA = Atlas("ProbeAtlasA");
        var rtB = Atlas("ProbeAtlasB");
        Material LoopMat(string n, RenderTexture src, float far, float primary)
        {
            var m = Save(new Material(loopShader) { name = n }, n + ".mat");
            m.SetTexture("_Src", src); m.SetFloat("_Far", far); m.SetFloat("_Primary", primary);
            m.SetFloat("_StoreRows", StoreRows); m.SetFloat("_Groups", groups);
            return m;
        }
        var matA = LoopMat("ProbeLoopA", rtB, FarA, 1);
        var matB = LoopMat("ProbeLoopB", rtA, FarB, 0);
        var groupMat = Save(new Material(groupShader) { name = "ProbeGroup" }, "ProbeGroup.mat");
        groupMat.SetFloat("_Far", FarA); groupMat.SetFloat("_AtlasW", AtlasW); groupMat.SetFloat("_AtlasH", AtlasH); groupMat.SetFloat("_StoreRows", StoreRows);
        var hudMat = Save(new Material(hudShader) { name = "ProbeHud" }, "ProbeHud.mat");
        hudMat.SetTexture("_Atlas", rtA); hudMat.SetFloat("_StoreRows", StoreRows);

        // meshes: the group mesh has two quads (uv.y 0..1 = chunk quad, 2..3 = status quad); both meshes get large
        // bounds so they are never frustum culled (their shaders place the vertices themselves)
        var groupMesh = new Mesh { name = "ProbeGroupMesh" };
        groupMesh.vertices = new[] { new Vector3(-.5f, -.5f), new Vector3(.5f, -.5f), new Vector3(-.5f, .5f), new Vector3(.5f, .5f),
                                     new Vector3(-.5f, -.5f), new Vector3(.5f, -.5f), new Vector3(-.5f, .5f), new Vector3(.5f, .5f) };
        groupMesh.uv = new[] { new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 1), new Vector2(1, 1),
                               new Vector2(0, 2), new Vector2(1, 2), new Vector2(0, 3), new Vector2(1, 3) };
        groupMesh.triangles = new[] { 0, 2, 1, 1, 2, 3, 4, 6, 5, 5, 6, 7 };
        groupMesh.bounds = new Bounds(Vector3.zero, Vector3.one * 2);
        Save(groupMesh, "ProbeGroupMesh.asset");
        var hudMesh = new Mesh { name = "ProbeHudMesh" };
        hudMesh.vertices = new[] { new Vector3(-.5f, -.5f), new Vector3(.5f, -.5f), new Vector3(-.5f, .5f), new Vector3(.5f, .5f) };
        hudMesh.uv = new[] { new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 1), new Vector2(1, 1) };
        hudMesh.triangles = new[] { 0, 2, 1, 1, 2, 3 };
        hudMesh.bounds = new Bounds(Vector3.zero, Vector3.one * 10000);
        Save(hudMesh, "ProbeHudMesh.asset");
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
        var hud = new GameObject("Hud");
        hud.transform.SetParent(root.transform, false);
        hud.transform.localPosition = new Vector3(0, 1.5f, 0);
        Renderer(hud, hudMesh, hudMat);
        hud.SetActive(false);

        var loop = new GameObject("Loop");
        loop.transform.SetParent(root.transform, false);
        loop.transform.localPosition = new Vector3(0, -4, 0);
        GameObject Cam(string n, Vector3 pos, RenderTexture target, Material mat, float far, int depth)
        {
            var go = new GameObject(n) { layer = LoopLayer };
            go.transform.SetParent(loop.transform, false);
            go.transform.localPosition = pos;
            var cam = go.AddComponent<Camera>();
            cam.orthographic = true; cam.orthographicSize = 0.01f; cam.nearClipPlane = 0.001f; cam.farClipPlane = far;
            cam.clearFlags = CameraClearFlags.Nothing; cam.cullingMask = 1 << LoopLayer; cam.targetTexture = target;
            cam.allowHDR = false; cam.allowMSAA = false; cam.depth = depth; cam.enabled = false;
            var q = new GameObject("Quad") { layer = LoopLayer };
            q.transform.SetParent(go.transform, false);
            q.transform.localPosition = new Vector3(0, 0, 0.012f);
            q.transform.localScale = Vector3.one * 0.1f;
            Renderer(q, quadMesh, mat);
            return go;
        }
        var camA = Cam("CamA", Vector3.zero, rtA, matA, FarA, -111);
        Cam("CamB", new Vector3(0, 0, 1), rtB, matB, FarB, -110);
        for (int g = 0; g < groups; g++)
        {
            var q = new GameObject($"G{g}") { layer = LoopLayer };
            q.transform.SetParent(camA.transform, false);
            q.transform.localPosition = new Vector3(0, 0, 0.012f);
            q.transform.localScale = Vector3.one * 0.01f;
            var r = Renderer(q, groupMesh, groupMat);
            // the group index differs per renderer: a property block is not kept in a prefab, so give each its own
            // material (they are tiny; all share the shader)
            var m = Save(new Material(groupMat) { name = $"ProbeGroup{g}" }, $"ProbeGroup{g}.mat");
            m.SetFloat("_Group", g);
            r.sharedMaterial = m;
        }

        // ---- FX
        AnimationCurve Const(float v) => new AnimationCurve(new Keyframe(0, v), new Keyframe(1f / 60f, v));
        var clips = new List<(AnimationClip clip, string param)>();
        var baseClip = new AnimationClip { name = "ProbeBase" };
        for (int i = 0; i < k; i++)
        {
            string path = $"Loop/CamA/G{i / 32}", prop = $"material._F{i % 32}";
            var c = new AnimationClip { name = $"Probe_{Prefix}{i}" };
            AnimationUtility.SetEditorCurve(c, EditorCurveBinding.FloatCurve(path, typeof(MeshRenderer), prop), Const(1));
            AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve(path, typeof(MeshRenderer), prop), Const(0));
            clips.Add((c, $"{Prefix}{i}"));
        }
        foreach (var (param, path, prop) in new[] { (SessionParam, "Loop/CamB/Quad", "material._Session"), (TargetParam, "Loop/CamB/Quad", "material._Target"), (HudParam, "Hud", "material._Show") })
        {
            var c = new AnimationClip { name = $"Probe_{param}" };
            AnimationUtility.SetEditorCurve(c, EditorCurveBinding.FloatCurve(path, typeof(MeshRenderer), prop), Const(1));
            AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve(path, typeof(MeshRenderer), prop), Const(0));
            clips.Add((c, param));
        }
        var ctrlPath = $"{gen}/ProbeFX.controller";
        if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(ctrlPath) != null) AssetDatabase.DeleteAsset(ctrlPath);
        var ctrl = AnimatorController.CreateAnimatorControllerAtPath(ctrlPath);
        foreach (var (_, p) in clips) ctrl.AddParameter(new AnimatorControllerParameter { name = p, type = AnimatorControllerParameterType.Float, defaultFloat = p == HudParam ? 1 : 0 });
        ctrl.AddParameter(new AnimatorControllerParameter { name = "ProbeOne", type = AnimatorControllerParameterType.Float, defaultFloat = 1 });
        ctrl.AddParameter("IsLocal", AnimatorControllerParameterType.Bool);
        // clips live inside the controller asset (thousands of .anim files would slow the project down)
        foreach (var (c, _) in clips) AssetDatabase.AddObjectToAsset(c, ctrl);
        AssetDatabase.AddObjectToAsset(baseClip, ctrl);
        var tree = new BlendTree { name = "ProbeDirect", blendType = BlendTreeType.Direct, useAutomaticThresholds = false, hideFlags = HideFlags.HideInHierarchy };
        tree.children = clips.Select(c => new ChildMotion { motion = c.clip, directBlendParameter = c.param, timeScale = 1 })
            .Append(new ChildMotion { motion = baseClip, directBlendParameter = "ProbeOne", timeScale = 1 }).ToArray();
        AssetDatabase.AddObjectToAsset(tree, ctrl);
        var so = new SerializedObject(tree);
        var norm = so.FindProperty("m_NormalizedBlendValues");
        if (norm != null) { norm.boolValue = false; so.ApplyModifiedPropertiesWithoutUndo(); }
        var sm = ctrl.layers[0].stateMachine;
        var run = sm.AddState("ProbeRun"); run.motion = tree; run.writeDefaultValues = true; sm.defaultState = run;

        // layer 1: cameras and overlay only for the wearer
        ctrl.AddLayer("ProbeLocalGate");
        var layers = ctrl.layers;
        layers[0].name = "ProbeData"; layers[0].defaultWeight = 1; layers[1].defaultWeight = 1;
        ctrl.layers = layers;
        var onClip = new AnimationClip { name = "ProbeLocalOn" };
        var offClip = new AnimationClip { name = "ProbeLocalOff" };
        foreach (var (clip, v) in new[] { (onClip, 1f), (offClip, 0f) })
        {
            foreach (var c in new[] { "Loop/CamA", "Loop/CamB" }) AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve(c, typeof(Camera), "m_Enabled"), Const(v));
            AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("Hud", typeof(GameObject), "m_IsActive"), Const(v));
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
        Debug.Log($"[Probe] built {prefabPath} (K={k}, groups={groups}, {clips.Count} parameters)");
        return prefabPath;
    }

    static Type FindType(string fullName) =>
        AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(fullName, false)).FirstOrDefault(t => t != null);

    // Modular Avatar Merge Animator (FX, relative paths), through reflection so this compiles without MA
    static void AddMergeAnimator(GameObject root, RuntimeAnimatorController ctrl)
    {
        var t = FindType("nadena.dev.modular_avatar.core.ModularAvatarMergeAnimator");
        if (t == null) { Debug.LogWarning("[Probe] Modular Avatar not found: add the FX controller manually."); return; }
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
        if (t == null) { Debug.LogWarning("[Probe] Modular Avatar not found: add the parameters manually."); return; }
        var c = root.AddComponent(t);
        var so = new SerializedObject(c);
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
            bool hudOn = names[i] == HudParam;
            el.FindPropertyRelative("defaultValue").floatValue = hudOn ? 1 : 0;
            var hasDef = el.FindPropertyRelative("hasExplicitDefaultValue");
            if (hasDef != null) hasDef.boolValue = hudOn;
            el.FindPropertyRelative("saved").boolValue = false;
        }
        so.ApplyModifiedPropertiesWithoutUndo();
    }

    public static void BuildBatch()
    {
        var args = Environment.GetCommandLineArgs();
        int i = Array.IndexOf(args, "-probeK");
        var ks = i >= 0 ? args[i + 1].Split(',').Select(int.Parse) : new[] { 512 };
        foreach (var k in ks) Build(k);
        EditorApplication.Exit(0);
    }
}

public class ParamroomLocalProbeWindow : EditorWindow
{
    int k = 512;
    [MenuItem("Tools/Paramroom/Local Probe Builder")]
    static void Open() => GetWindow<ParamroomLocalProbeWindow>("Local Probe");
    void OnGUI()
    {
        EditorGUILayout.HelpBox("研究用（docs/research/12）。自分のアバターへ OSC で画像を送る経路の測定用プレハブを作ります。\n" +
            "パラメータはすべて同期しない Float です（同期ビットは使いません）。カメラと画面の表示は着ている本人にだけ出ます。", MessageType.Info);
        k = EditorGUILayout.IntPopup("パラメータ数 K", k, new[] { "128", "256", "512", "1024", "2048", "4096" }, new[] { 128, 256, 512, 1024, 2048, 4096 });
        if (GUILayout.Button("作る")) EditorGUIUtility.PingObject(AssetDatabase.LoadAssetAtPath<GameObject>(ParamroomLocalProbeBuilder.Build(k)));
    }
}
