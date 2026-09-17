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
        // Base child, always weight 1 (ImagePad_One): writes 0 to every data property (and enables the loop cameras).
        // Without it, a Direct blend tree child whose weight parameter is 0 is skipped and the material property
        // keeps its previous value instead of becoming 0 (observed in VRChat 2026-09-17: zero bytes stayed stale).
        // With the base child the property is always written: value = 1 * 0 + D_i * 1 = D_i.
        {
            var baseClip = new AnimationClip { name = "ImagePad_Base" };
            var zero = new AnimationCurve(new Keyframe(0, 0), new Keyframe(1f / 60f, 0));
            for (int i = 0; i < byteCount; i++)
                AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve("Board", typeof(MeshRenderer), $"material._P{i}"), zero);
            AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve("Board", typeof(MeshRenderer), "material._IsLocal"), zero);
            AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve("Board", typeof(MeshRenderer), "material._IsOnFriendsList"), zero);
            if (withLoop)
                foreach (var cam in new[] { "Loop/CamA", "Loop/CamB" })
                    AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve(cam, typeof(Camera), "m_Enabled"), new AnimationCurve(new Keyframe(0, 1), new Keyframe(1f / 60f, 1)));
            CreateOrReplace(baseClip, $"{Gen}/ImagePad_Base.anim");
            children.Add(new ChildMotion { motion = baseClip, directBlendParameter = "ImagePad_One", timeScale = 1 });
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

    internal static void AddMergeAnimator(GameObject root, RuntimeAnimatorController ctrl)
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

    internal static void AddParameters(GameObject root, int byteCount)
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

public static class ImagePadMeasureShaderCheck
{
    // batchmode (with graphics): -executeMethod ImagePadMeasureShaderCheck.Run
    public static void Run()
    {
        int errors = 0;
        foreach (var name in new[] { "ImagePad/MeasureBoard", "ImagePad/LoopCounter" })
        {
            var s = Shader.Find(name);
            if (s == null) { Debug.LogError($"[ImagePad] shader missing: {name}"); errors++; continue; }
            var msgs = ShaderUtil.GetShaderMessages(s);
            foreach (var m in msgs) Debug.Log($"[ImagePad] {name}: {m.severity} line {m.line}: {m.message}");
            if (ShaderUtil.ShaderHasError(s)) errors++;
            Debug.Log($"[ImagePad] {name}: hasError={ShaderUtil.ShaderHasError(s)} supported={s.isSupported}");
        }
        EditorApplication.Exit(errors == 0 ? 0 : 1);
    }
}

public static class ImagePadMeasureRenderTest
{
    // batchmode (with graphics): -executeMethod ImagePadMeasureRenderTest.Run -imagepadOut <dir>
    // Renders the board for known packets (and the camera loop for 10 A/B iterations) into PNGs for the decoder test.
    static uint ExpectedByte(uint mode, uint seq, uint j)
    {
        unchecked
        {
            if (mode == 1) return (seq + j * 37u) & 255u;
            uint h = (seq * 2654435761u) ^ (j * 2246822519u);
            h ^= h >> 15; h *= 739982445u; h ^= h >> 12; h *= 695872825u; h ^= h >> 15;
            return h & 255u;
        }
    }
    static float[] Packet(uint seq, uint mode, uint epoch)
    {
        var p = new float[32];
        p[0] = (seq >> 8) & 255; p[1] = seq & 255; p[2] = mode; p[3] = epoch;
        for (uint j = 4; j < 32; j++) p[j] = ExpectedByte(mode, seq, j);
        return p;
    }

    public static void Run()
    {
        var args = Environment.GetCommandLineArgs();
        int oi = Array.IndexOf(args, "-imagepadOut");
        string outDir = oi >= 0 ? args[oi + 1] : "ImagePadRenderTest";
        System.IO.Directory.CreateDirectory(outDir);
        try
        {
            var boardMat = new Material(Shader.Find("ImagePad/MeasureBoard"));
            var loopShader = Shader.Find("ImagePad/LoopCounter");
            var quadMesh = Resources.GetBuiltinResource<Mesh>("Quad.fbx");

            // camera loop
            RenderTexture MakeRT() { var d = new RenderTextureDescriptor(4, 4, RenderTextureFormat.ARGB32, 0) { sRGB = false }; var rt = new RenderTexture(d) { filterMode = FilterMode.Point }; rt.Create(); return rt; }
            var rtA = MakeRT(); var rtB = MakeRT();
            Camera MakeLoopCam(Vector3 pos, RenderTexture target, RenderTexture src, float far)
            {
                var go = new GameObject("loopcam") { layer = 12 };
                go.transform.position = pos;
                var cam = go.AddComponent<Camera>();
                cam.orthographic = true; cam.orthographicSize = 0.01f; cam.nearClipPlane = 0.001f; cam.farClipPlane = far;
                cam.clearFlags = CameraClearFlags.SolidColor; cam.backgroundColor = Color.clear; cam.cullingMask = 1 << 12;
                cam.targetTexture = target; cam.allowHDR = false; cam.allowMSAA = false; cam.enabled = false;
                var q = new GameObject("loopquad") { layer = 12 };
                q.transform.SetParent(go.transform, false);
                q.transform.localPosition = new Vector3(0, 0, 0.012f);
                q.transform.localScale = Vector3.one * 0.1f;
                q.AddComponent<MeshFilter>().sharedMesh = quadMesh;
                var m = new Material(loopShader); m.SetTexture("_Src", src); m.SetFloat("_Far", far);
                q.AddComponent<MeshRenderer>().sharedMaterial = m;
                return cam;
            }
            var camA = MakeLoopCam(new Vector3(100, 0, 0), rtA, rtB, 0.0217f);
            var camB = MakeLoopCam(new Vector3(100, 0, 1), rtB, rtA, 0.0219f);
            for (int i = 0; i < 10; i++) { camA.Render(); camB.Render(); }

            // board + viewer camera
            var board = new GameObject("board");
            board.transform.position = Vector3.zero;
            board.AddComponent<MeshFilter>().sharedMesh = quadMesh;
            board.AddComponent<MeshRenderer>().sharedMaterial = boardMat;
            var vgo = new GameObject("viewer");
            vgo.transform.position = new Vector3(0, 0, -1);
            var view = vgo.AddComponent<Camera>();
            view.orthographic = true; view.orthographicSize = 0.6f; view.clearFlags = CameraClearFlags.SolidColor; view.backgroundColor = Color.gray;
            view.cullingMask = 1 << 0; view.enabled = false; view.allowMSAA = false;
            var target = new RenderTexture(512, 512, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            view.targetTexture = target;

            void Shot(string name, float[] p, float isLocal, float isFriend, Texture loop)
            {
                boardMat.SetFloat("_ByteCount", 32);
                for (int i = 0; i < 32; i++) boardMat.SetFloat($"_P{i}", p[i]);
                boardMat.SetFloat("_IsLocal", isLocal); boardMat.SetFloat("_IsOnFriendsList", isFriend);
                boardMat.SetTexture("_LoopTex", loop);
                view.Render();
                RenderTexture.active = target;
                var tex = new Texture2D(512, 512, TextureFormat.RGB24, false);
                tex.ReadPixels(new Rect(0, 0, 512, 512), 0, 0);
                tex.Apply();
                RenderTexture.active = null;
                System.IO.File.WriteAllBytes(System.IO.Path.Combine(outDir, name + ".png"), tex.EncodeToPNG());
            }
            Shot("t1_hash_seq4660_ep7_local", Packet(4660, 0, 7), 1, 0, rtA);
            Shot("t2_sweep_seq300_ep200_friend", Packet(300, 1, 200), 0, 1, null);
            var torn = Packet(1000, 0, 9); var other = Packet(1001, 0, 9);
            for (int i = 16; i < 32; i++) torn[i] = other[i];
            Shot("t3_torn_seq1000", torn, 0, 0, null);
            Shot("t4_allzero", new float[32], 0, 0, null);
            var inexact = Packet(77, 0, 3); inexact[10] += 0.4f;
            Shot("t5_inexact_seq77", inexact, 0, 0, null);
            Debug.Log("[ImagePad] render test written to " + outDir);
            EditorApplication.Exit(0);
        }
        catch (Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
    }
}

public static class ImagePadMeasureAnimatorTest
{
    // batchmode: -executeMethod ImagePadMeasureAnimatorTest.Run
    // Drives the generated FX controller with a plain Animator (no VRChat/MA) and reads the material properties
    // back from the renderer's property block, for packets containing zero bytes. Also runs the same test with the
    // base child removed to reproduce the "zero byte keeps previous value" behaviour.
    public static void Run()
    {
        int failures = 0;
        try
        {
            ImagePadMeasureBuilder.Build(32, true);
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/ImagePadMeasure/ImagePadMeasure.prefab");
            var ctrl = AssetDatabase.LoadAssetAtPath<AnimatorController>("Assets/ImagePadMeasure/Generated/ImagePadMeasure_FX.controller");
            failures += RunCase("with base child", prefab, ctrl, expectStale: false);

            // variant without the base child
            var copyPath = "Assets/ImagePadMeasure/Generated/ImagePadMeasure_FX_nobase.controller";
            AssetDatabase.CopyAsset("Assets/ImagePadMeasure/Generated/ImagePadMeasure_FX.controller", copyPath);
            var noBase = AssetDatabase.LoadAssetAtPath<AnimatorController>(copyPath);
            var tree = (BlendTree)noBase.layers[0].stateMachine.defaultState.motion;
            tree.children = tree.children.Where(c => c.directBlendParameter != "ImagePad_One").ToArray();
            // NOTE: plain Unity did not reproduce the stale-zero behaviour seen in VRChat (2026-09-17); this case is
            // informational only. The base child makes the property written every frame regardless of the cause.
            RunCase("without base child (old, informational)", prefab, noBase, expectStale: false);
        }
        catch (Exception e) { Debug.LogException(e); failures++; }
        Debug.Log($"[ImagePad] animator test failures={failures}");
        EditorApplication.Exit(failures == 0 ? 0 : 1);
    }

    static int RunCase(string label, GameObject prefab, RuntimeAnimatorController ctrl, bool expectStale)
    {
        var go = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
        var anim = go.AddComponent<Animator>();
        anim.runtimeAnimatorController = ctrl;
        anim.cullingMode = AnimatorCullingMode.AlwaysAnimate;
        anim.Rebind();
        var renderer = go.transform.Find("Board").GetComponent<MeshRenderer>();
        var mpb = new MaterialPropertyBlock();
        float Read(int i) { renderer.GetPropertyBlock(mpb); return mpb.GetFloat($"_P{i}"); }
        void Set(int i, float v) => anim.SetFloat($"D{i}", v);

        int bad = 0;
        foreach (var (step, v0, v5) in new[] { (1, 18f, 255f), (2, 0f, 7f), (3, 200f, 0f), (4, 0f, 0f) })
        {
            Set(0, v0); Set(5, v5);
            anim.Update(1f / 60f); anim.Update(1f / 60f);
            float r0 = Read(0), r5 = Read(5);
            bool ok = Mathf.Abs(r0 - v0) < 1e-4f && Mathf.Abs(r5 - v5) < 1e-4f;
            Debug.Log($"[ImagePad] {label} step {step}: set D0={v0} D5={v5} -> _P0={r0} _P5={r5} {(ok ? "OK" : "MISMATCH")}");
            if (!ok) bad++;
        }
        UnityEngine.Object.DestroyImmediate(go);
        bool pass = expectStale ? bad > 0 : bad == 0;
        Debug.Log($"[ImagePad] {label}: {(pass ? "PASS" : "FAIL")} (mismatching steps {bad}, expectStale={expectStale})");
        return pass ? 0 : 1;
    }
}

public static class ImagePadPrimTest
{
    // batchmode (with graphics): -executeMethod ImagePadPrimTest.Run -imagepadOut <dir>
    // Feeds exported prim packets (TestData/prim-kodim23.json) into the PrimDecoder camera loop by setting material
    // properties directly (as the FX blend tree would), renders, and saves the display canvas + timing.
    public static void Run()
    {
        var args = Environment.GetCommandLineArgs();
        int oi = Array.IndexOf(args, "-imagepadOut");
        string outDir = oi >= 0 ? args[oi + 1] : "ImagePadPrimTest";
        System.IO.Directory.CreateDirectory(outDir);
        try
        {
            var json = System.IO.File.ReadAllText("Assets/ImagePadMeasure/TestData/prim-kodim23.json");
            int pi = json.IndexOf("\"packets\"");
            var nums = System.Text.RegularExpressions.Regex.Matches(json.Substring(pi), "[0-9]+").Cast<System.Text.RegularExpressions.Match>().Select(m => int.Parse(m.Value)).ToList();
            int nPackets = nums.Count / 32;
            var shader = Shader.Find("ImagePad/PrimDecoder");
            if (shader == null) throw new Exception("PrimDecoder shader missing");
            RenderTexture MakeAtlas() { var d = new RenderTextureDescriptor(512, 288, RenderTextureFormat.ARGBHalf, 0) { sRGB = false }; var rt = new RenderTexture(d) { filterMode = FilterMode.Point }; rt.Create(); return rt; }
            var rtA = MakeAtlas(); var rtB = MakeAtlas();
            var quadMesh = Resources.GetBuiltinResource<Mesh>("Quad.fbx");
            Material matA = new Material(shader), matB = new Material(shader);
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
            void SetPacket(int k)
            {
                for (int b = 0; b < 32; b++) { float v = nums[k * 32 + b]; matA.SetFloat($"_P{b}", v); matB.SetFloat($"_P{b}", v); }
            }
            void Step() { camA.Render(); camB.Render(); }
            var sw = System.Diagnostics.Stopwatch.StartNew();
            for (int k = 0; k < nPackets; k++) { SetPacket(k); Step(); }
            // run full redraw cycles with the last packet held
            int nBatches = (1003 + 31) / 32;
            for (int s = 0; s < nBatches * 2 + 2; s++) Step();
            var tex = new Texture2D(512, 288, TextureFormat.RGBAHalf, false);
            RenderTexture.active = rtA;
            tex.ReadPixels(new Rect(0, 0, 512, 288), 0, 0);
            tex.Apply();
            RenderTexture.active = null;
            sw.Stop();
            int steps = nPackets + nBatches * 2 + 2;
            // timing of pure redraw steps (GPU synced by a 1x1 readback)
            var probe = new Texture2D(1, 1, TextureFormat.RGBAHalf, false);
            var sw2 = System.Diagnostics.Stopwatch.StartNew();
            for (int s = 0; s < 120; s++) Step();
            RenderTexture.active = rtA; probe.ReadPixels(new Rect(0, 0, 1, 1), 0, 0); probe.Apply(); RenderTexture.active = null;
            sw2.Stop();
            // dump display region as PNG (0..255 values)
            var outTex = new Texture2D(256, 256, TextureFormat.RGB24, false);
            var px = tex.GetPixels();
            var o = new Color32[256 * 256];
            for (int y = 0; y < 256; y++)
                for (int x = 0; x < 256; x++)
                {
                    var c = px[y * 512 + 256 + x];
                    o[y * 256 + x] = new Color32((byte)Mathf.Clamp(Mathf.Round(c.r), 0, 255), (byte)Mathf.Clamp(Mathf.Round(c.g), 0, 255), (byte)Mathf.Clamp(Mathf.Round(c.b), 0, 255), 255);
                }
            outTex.SetPixels32(o);
            outTex.Apply();
            System.IO.File.WriteAllBytes(System.IO.Path.Combine(outDir, "prim-display.png"), outTex.EncodeToPNG());
            // store sanity: count present primitives
            int present = 0;
            for (int j = 0; j < 1003; j++) { int t = 2 * j + 1; var c = px[(256 + t / 512) * 512 + t % 512]; if (((int)Mathf.Round(c.a) & 1) == 1) present++; }
            Debug.Log($"[ImagePad] prim test: packets={nPackets} steps={steps} total={sw.ElapsedMilliseconds}ms, redraw 120 steps={sw2.ElapsedMilliseconds}ms ({sw2.ElapsedMilliseconds / 120.0:F2} ms/step) present={present} counter={px[280 * 512].r} epoch={px[280 * 512 + 1].r}");
            EditorApplication.Exit(0);
        }
        catch (Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
    }
}
