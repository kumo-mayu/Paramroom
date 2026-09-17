// ImagePad primitive decoder prefab builder (prototype, 256 bit = 32 Int).
// Menus: Tools/ImagePad/Build Prim Decoder Prefab (256 bit)                -> canvas 256, 1003 primitives (u = 8)
//        Tools/ImagePad/Build Prim Decoder Prefab (256 bit, 512 canvas, 4000) -> canvas 512, 4003 primitives (u = 10)
// Generates Assets/ImagePadMeasure/ImagePadPrimDecoder.prefab (or ImagePadPrimDecoder512.prefab):
//   - two ARGBHalf atlas RenderTextures, 512x288 / 1024x536 (double-buffered camera loop, see ImagePadPrimDecoder.shader)
//   - loop cameras A/B (disabled, enabled by the FX animation) with full-viewport decoder quads
//   - a display quad (ImagePad/PrimDisplay) showing the decoded image
//   - FX controller: D0..D31 (Float in the animator) -> Direct blend tree -> material._Pi on both decoder quads,
//     plus an always-on base child that writes 0 to every _Pi and enables the cameras
//   - Modular Avatar Merge Animator + Parameters (same D0..D31 as the measurement prefab; both can coexist)
using System;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

public static class ImagePadPrimBuilder
{
    const string Root = "Assets/ImagePadMeasure";
    const int LoopLayer = 12;

    [MenuItem("Tools/ImagePad/Build Prim Decoder Prefab (256 bit)")]
    public static void Build() => Build(256, 1003, 8, 0.0237f, 0.0239f, "");

    [MenuItem("Tools/ImagePad/Build Prim Decoder Prefab (256 bit, 512 canvas, 4000)")]
    public static void Build512() => Build(512, 4003, 10, 0.0247f, 0.0249f, "512");

    // canvas: texels = coordinate range; nPrims / unitBits must match sim/codecs/prim.js layout for the sender config;
    // farA / farB: unique loop camera far planes (the quads only draw for their own camera)
    static void Build(int canvas, int nPrims, int unitBits, float FarA, float FarB, string suffix)
    {
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
        matA.SetTexture("_Src", rtB); matA.SetFloat("_Far", FarA);
        var matB = Save(new Material(decShader) { name = "ImagePadPrimDecB" }, "ImagePadPrimDecB.mat");
        matB.SetTexture("_Src", rtA); matB.SetFloat("_Far", FarB);
        var dispMat = Save(new Material(dispShader) { name = "ImagePadPrimDisplay" }, "ImagePadPrimDisplay.mat");
        dispMat.SetTexture("_Atlas", rtA); dispMat.SetFloat("_Canvas", canvas);
        foreach (var m in new[] { matA, matB })
        {
            m.SetFloat("_Canvas", canvas); m.SetFloat("_R", canvas); m.SetFloat("_NPrims", nPrims); m.SetFloat("_U", unitBits);
            EditorUtility.SetDirty(m);
        }

        var root = new GameObject("ImagePadPrimDecoder" + suffix);
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
        MakeCam("CamA", Vector3.zero, rtA, matA, FarA);
        MakeCam("CamB", new Vector3(0, 0, 1), rtB, matB, FarB);

        // clips
        string[] quads = { "Loop/CamA/Quad", "Loop/CamB/Quad" };
        var children = new System.Collections.Generic.List<ChildMotion>();
        AnimationCurve Const(float v) => new AnimationCurve(new Keyframe(0, v), new Keyframe(1f / 60f, v));
        for (int i = 0; i < 32; i++)
        {
            var clip = new AnimationClip { name = $"ImagePadPrim_Set_P{i}" };
            foreach (var q in quads) AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve(q, typeof(MeshRenderer), $"material._P{i}"), Const(1));
            children.Add(new ChildMotion { motion = Save(clip, clip.name + ".anim"), directBlendParameter = $"D{i}", timeScale = 1 });
        }
        var baseClip = new AnimationClip { name = "ImagePadPrim_Base" };
        foreach (var q in quads) for (int i = 0; i < 32; i++) AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve(q, typeof(MeshRenderer), $"material._P{i}"), Const(0));
        foreach (var c in new[] { "Loop/CamA", "Loop/CamB" }) AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve(c, typeof(Camera), "m_Enabled"), Const(1));
        children.Add(new ChildMotion { motion = Save(baseClip, baseClip.name + ".anim"), directBlendParameter = "ImagePadPrim_One", timeScale = 1 });

        var ctrlPath = $"{Gen}/ImagePadPrim_FX.controller";
        if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(ctrlPath) != null) AssetDatabase.DeleteAsset(ctrlPath);
        var ctrl = AnimatorController.CreateAnimatorControllerAtPath(ctrlPath);
        for (int i = 0; i < 32; i++) ctrl.AddParameter($"D{i}", AnimatorControllerParameterType.Float);
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
        ImagePadMeasureBuilder.AddParameters(root, 32);
        PrefabUtility.SaveAsPrefabAsset(root, $"{Root}/ImagePadPrimDecoder{suffix}.prefab");
        UnityEngine.Object.DestroyImmediate(root);
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        Debug.Log($"[ImagePad] built Assets/ImagePadMeasure/ImagePadPrimDecoder{suffix}.prefab");
    }

    public static void BuildBatch()
    {
        try { Build(); Build512(); EditorApplication.Exit(0); } catch (Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
    }
}
