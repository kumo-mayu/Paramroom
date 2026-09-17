// ImagePad measurement prefab builder.
// Menu: Tools/ImagePad/Build Measurement Prefab
// Generates (under Assets/ImagePadMeasure/Generated):
//   - materials, two 4x4 linear RGBA8 RenderTextures (double-buffered camera loop)
//   - animation clips that set material._Pi = 1 on the board renderer (Direct blend tree children)
//   - an FX animator controller: params D0..D(n-1), IsLocal, IsOnFriendsList (all Float in the animator),
//     one layer / one state (Write Defaults ON) with a Direct blend tree (not normalized)
//   - a prefab "ImagePadMeasure" with Modular Avatar Merge Animator (FX, relative paths) and
//     Modular Avatar Parameters (D0..D(n-1) as synced Int, not saved)
// Expression parameter Int values arrive in the animator as Float ("int -> float: directly converted"),
// the Direct tree weight x constant 1 puts the exact integer into material._Pi, the shader rounds it.
// Modular Avatar components are added by type name + SerializedObject so no assembly reference is needed.
using System;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

public static class ImagePadMeasureBuilder
{
    const string Root = "Assets/ImagePadMeasure";
    const string Gen = Root + "/Generated";
    const int LoopLayer = 12; // UiMenu
    const float FarA = 0.0217f, FarB = 0.0219f;

    [MenuItem("Tools/ImagePad/Build Measurement Prefab (256 bit = 32 Int)")]
    public static void Build32() => Build(32, true);

    [MenuItem("Tools/ImagePad/Build Measurement Prefab (128 bit = 16 Int)")]
    public static void Build16() => Build(16, true);

    [MenuItem("Tools/ImagePad/Build Measurement Prefab (64 bit = 8 Int)")]
    public static void Build8() => Build(8, true);

    // for batchmode: -executeMethod ImagePadMeasureBuilder.BuildBatch
    public static void BuildBatch()
    {
        try { Build(32, true); EditorApplication.Exit(0); }
        catch (Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
    }

    static void EnsureFolder(string path)
    {
        if (AssetDatabase.IsValidFolder(path)) return;
        var parent = System.IO.Path.GetDirectoryName(path).Replace('\\', '/');
        EnsureFolder(parent);
        AssetDatabase.CreateFolder(parent, System.IO.Path.GetFileName(path));
    }

    static T CreateOrReplace<T>(T obj, string path) where T : UnityEngine.Object
    {
        if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(path) != null) AssetDatabase.DeleteAsset(path);
        AssetDatabase.CreateAsset(obj, path);
        return obj;
    }

    static AnimationClip ConstantClip(string name, string path, Type type, string property, float value)
    {
        var clip = new AnimationClip { name = name };
        var curve = new AnimationCurve(new Keyframe(0, value), new Keyframe(1f / 60f, value));
        AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve(path, type, property), curve);
        return CreateOrReplace(clip, $"{Gen}/{name}.anim");
    }

    public static void Build(int byteCount, bool withLoop)
    {
        EnsureFolder(Gen);
        var boardShader = Shader.Find("ImagePad/MeasureBoard");
        var loopShader = Shader.Find("ImagePad/LoopCounter");
        if (boardShader == null || loopShader == null) throw new Exception("ImagePad shaders not found (import Assets/ImagePadMeasure/Shaders)");

        // RenderTextures
        RenderTexture MakeRT(string name)
        {
            var desc = new RenderTextureDescriptor(4, 4, RenderTextureFormat.ARGB32, 0) { sRGB = false, msaaSamples = 1, useMipMap = false, autoGenerateMips = false };
            var rt = new RenderTexture(desc) { name = name, filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, antiAliasing = 1 };
            return CreateOrReplace(rt, $"{Gen}/{name}.renderTexture");
        }
        var rtA = MakeRT("ImagePadLoopA");
        var rtB = MakeRT("ImagePadLoopB");

        // Materials
        var boardMat = CreateOrReplace(new Material(boardShader) { name = "ImagePadBoard" }, $"{Gen}/ImagePadBoard.mat");
        boardMat.SetFloat("_ByteCount", byteCount);
        boardMat.SetTexture("_LoopTex", withLoop ? rtA : null);
        var matA = CreateOrReplace(new Material(loopShader) { name = "ImagePadLoopA" }, $"{Gen}/ImagePadLoopA.mat");
        matA.SetTexture("_Src", rtB); matA.SetFloat("_Far", FarA);
        var matB = CreateOrReplace(new Material(loopShader) { name = "ImagePadLoopB" }, $"{Gen}/ImagePadLoopB.mat");
        matB.SetTexture("_Src", rtA); matB.SetFloat("_Far", FarB);

        // Hierarchy
        var root = new GameObject("ImagePadMeasure");
        var quadMesh = Resources.GetBuiltinResource<Mesh>("Quad.fbx");
        var board = new GameObject("Board");
        board.transform.SetParent(root.transform, false);
        board.transform.localPosition = new Vector3(0, 1.3f, 0.45f);
        board.transform.localRotation = Quaternion.Euler(0, 180, 0);
        board.transform.localScale = Vector3.one * 0.45f;
        board.AddComponent<MeshFilter>().sharedMesh = quadMesh;
        var boardRenderer = board.AddComponent<MeshRenderer>();
        boardRenderer.sharedMaterial = boardMat;
        boardRenderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        boardRenderer.receiveShadows = false;

        if (withLoop)
        {
            var loop = new GameObject("Loop");
            loop.transform.SetParent(root.transform, false);
            loop.transform.localPosition = new Vector3(0, -3, 0);
            void MakeCam(string name, Vector3 pos, RenderTexture target, Material mat, float far)
            {
                var camGo = new GameObject(name) { layer = LoopLayer };
                camGo.transform.SetParent(loop.transform, false);
                camGo.transform.localPosition = pos;
                var cam = camGo.AddComponent<Camera>();
                cam.orthographic = true;
                cam.orthographicSize = 0.01f;
                cam.nearClipPlane = 0.001f;
                cam.farClipPlane = far;
                cam.clearFlags = CameraClearFlags.SolidColor;
                cam.backgroundColor = Color.clear;
                cam.cullingMask = 1 << LoopLayer;
                cam.targetTexture = target;
                cam.allowHDR = false;
                cam.allowMSAA = false;
                cam.depth = -100;
                cam.enabled = false; // enabled by animation (required for remote avatars)
                var quad = new GameObject(name + "Quad") { layer = LoopLayer };
                quad.transform.SetParent(camGo.transform, false);
                quad.transform.localPosition = new Vector3(0, 0, 0.012f);
                quad.transform.localScale = Vector3.one * 0.1f;
                quad.AddComponent<MeshFilter>().sharedMesh = quadMesh;
                var r = quad.AddComponent<MeshRenderer>();
                r.sharedMaterial = mat;
                r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                r.receiveShadows = false;
            }
            MakeCam("CamA", new Vector3(0, 0, 0), rtA, matA, FarA);
            MakeCam("CamB", new Vector3(0, 0, 1), rtB, matB, FarB);
        }

        // Clips
        var children = new System.Collections.Generic.List<ChildMotion>();
        for (int i = 0; i < byteCount; i++)
            children.Add(new ChildMotion { motion = ConstantClip($"ImagePad_Set_P{i}", "Board", typeof(MeshRenderer), $"material._P{i}", 1), directBlendParameter = $"D{i}", timeScale = 1 });
        children.Add(new ChildMotion { motion = ConstantClip("ImagePad_Set_IsLocal", "Board", typeof(MeshRenderer), "material._IsLocal", 1), directBlendParameter = "IsLocal", timeScale = 1 });
        children.Add(new ChildMotion { motion = ConstantClip("ImagePad_Set_IsOnFriendsList", "Board", typeof(MeshRenderer), "material._IsOnFriendsList", 1), directBlendParameter = "IsOnFriendsList", timeScale = 1 });
        if (withLoop)
        {
            var camClip = new AnimationClip { name = "ImagePad_LoopOn" };
            foreach (var cam in new[] { "Loop/CamA", "Loop/CamB" })
                AnimationUtility.SetEditorCurve(camClip, EditorCurveBinding.FloatCurve(cam, typeof(Camera), "m_Enabled"), new AnimationCurve(new Keyframe(0, 1), new Keyframe(1f / 60f, 1)));
            CreateOrReplace(camClip, $"{Gen}/ImagePad_LoopOn.anim");
            children.Add(new ChildMotion { motion = camClip, directBlendParameter = "ImagePad_One", timeScale = 1 });
        }

        // Controller
        var ctrlPath = $"{Gen}/ImagePadMeasure_FX.controller";
        if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(ctrlPath) != null) AssetDatabase.DeleteAsset(ctrlPath);
        var ctrl = AnimatorController.CreateAnimatorControllerAtPath(ctrlPath);
        for (int i = 0; i < byteCount; i++) ctrl.AddParameter($"D{i}", AnimatorControllerParameterType.Float);
        ctrl.AddParameter("IsLocal", AnimatorControllerParameterType.Float);
        ctrl.AddParameter("IsOnFriendsList", AnimatorControllerParameterType.Float);
        ctrl.AddParameter(new AnimatorControllerParameter { name = "ImagePad_One", type = AnimatorControllerParameterType.Float, defaultFloat = 1 });
        var tree = new BlendTree { name = "ImagePadDirect", blendType = BlendTreeType.Direct, useAutomaticThresholds = false, hideFlags = HideFlags.HideInHierarchy };
        tree.children = children.ToArray();
        AssetDatabase.AddObjectToAsset(tree, ctrl);
        var treeSo = new SerializedObject(tree);
        var norm = treeSo.FindProperty("m_NormalizedBlendValues");
        if (norm != null) { norm.boolValue = false; treeSo.ApplyModifiedPropertiesWithoutUndo(); }
        var sm = ctrl.layers[0].stateMachine;
        var state = sm.AddState("ImagePadRun");
        state.motion = tree;
        state.writeDefaultValues = true;
        sm.defaultState = state;
        var layers = ctrl.layers;
        layers[0].name = "ImagePadMeasure";
        layers[0].defaultWeight = 1;
        ctrl.layers = layers;
        EditorUtility.SetDirty(ctrl);

        // Modular Avatar components
        AddMergeAnimator(root, ctrl);
        AddParameters(root, byteCount);

        var prefabPath = $"{Root}/ImagePadMeasure.prefab";
        PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
        UnityEngine.Object.DestroyImmediate(root);
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        Debug.Log($"[ImagePad] built {prefabPath} ({byteCount} Int = {byteCount * 8} bits, loop={withLoop})");
    }

    static Type FindType(string fullName) =>
        AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(fullName, false)).FirstOrDefault(t => t != null);

    static SerializedProperty Req(SerializedObject so, string name)
    {
        var p = so.FindProperty(name);
        if (p == null) throw new Exception($"[ImagePad] property '{name}' not found on {so.targetObject.GetType().FullName}");
        return p;
    }
    static SerializedProperty Req(SerializedProperty sp, string name)
    {
        var p = sp.FindPropertyRelative(name);
        if (p == null) throw new Exception($"[ImagePad] property '{name}' not found in {sp.propertyPath}");
        return p;
    }

    static void AddMergeAnimator(GameObject root, RuntimeAnimatorController ctrl)
    {
        var t = FindType("nadena.dev.modular_avatar.core.ModularAvatarMergeAnimator");
        if (t == null) { Debug.LogWarning("[ImagePad] Modular Avatar not found: add the FX controller to your avatar manually."); return; }
        var c = root.AddComponent(t);
        var so = new SerializedObject(c);
        Req(so, "animator").objectReferenceValue = ctrl;
        var layerType = Req(so, "layerType");
        var enumType = FindType("VRC.SDK3.Avatars.Components.VRCAvatarDescriptor+AnimLayerType");
        int fx = enumType != null ? (int)Enum.Parse(enumType, "FX") : 5;
        layerType.intValue = fx;
        Req(so, "pathMode").intValue = 0; // Relative
        Req(so, "deleteAttachedAnimator").boolValue = true;
        Req(so, "matchAvatarWriteDefaults").boolValue = false;
        so.ApplyModifiedPropertiesWithoutUndo();
    }

    static void AddParameters(GameObject root, int byteCount)
    {
        var t = FindType("nadena.dev.modular_avatar.core.ModularAvatarParameters");
        if (t == null) { Debug.LogWarning("[ImagePad] Modular Avatar not found: add D0..D(n-1) Int synced parameters manually."); return; }
        var c = root.AddComponent(t);
        var so = new SerializedObject(c);
        var list = Req(so, "parameters");
        var syncEnum = FindType("nadena.dev.modular_avatar.core.ParameterSyncType");
        int intSync = syncEnum != null ? (int)Enum.Parse(syncEnum, "Int") : 1;
        list.arraySize = byteCount;
        for (int i = 0; i < byteCount; i++)
        {
            var el = list.GetArrayElementAtIndex(i);
            Req(el, "nameOrPrefix").stringValue = $"D{i}";
            Req(el, "remapTo").stringValue = "";
            Req(el, "internalParameter").boolValue = false;
            Req(el, "isPrefix").boolValue = false;
            Req(el, "syncType").intValue = intSync;
            Req(el, "localOnly").boolValue = false;
            Req(el, "defaultValue").floatValue = 0;
            Req(el, "saved").boolValue = false;
        }
        so.ApplyModifiedPropertiesWithoutUndo();
    }
}
