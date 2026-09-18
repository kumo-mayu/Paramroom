// Paramroom measurement prefab builder.
// Menu: Tools/Paramroom/Build Measurement Prefab
// Generates (under Assets/ParamroomMeasure/Generated):
//   - materials, two 4x4 linear RGBA8 RenderTextures (double-buffered camera loop)
//   - animation clips that set material._Pi = 1 on the board renderer (Direct blend tree children)
//   - an FX animator controller: params D0..D(n-1), IsLocal, IsOnFriendsList (all Float in the animator),
//     one layer / one state (Write Defaults ON) with a Direct blend tree (not normalized)
//   - a prefab "ParamroomMeasure" with Modular Avatar Merge Animator (FX, relative paths) and
//     Modular Avatar Parameters (D0..D(n-1) as synced Int, not saved)
// Expression parameter Int values arrive in the animator as Float ("int -> float: directly converted"),
// the Direct tree weight x constant 1 puts the exact integer into material._Pi, the shader rounds it.
// Modular Avatar components are added by type name + SerializedObject so no assembly reference is needed.
using System;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

public static class ParamroomMeasureBuilder
{
    const string Root = "Assets/ParamroomMeasure";
    const string Gen = Root + "/Generated";
    const int LoopLayer = 12; // UiMenu
    const float FarA = 0.0217f, FarB = 0.0219f;

    [MenuItem("Tools/Paramroom/Build Measurement Prefab (256 bit = 32 Int)")]
    public static void Build32() => Build(32, true);

    [MenuItem("Tools/Paramroom/Build Measurement Prefab (128 bit = 16 Int)")]
    public static void Build16() => Build(16, true);

    [MenuItem("Tools/Paramroom/Build Measurement Prefab (64 bit = 8 Int)")]
    public static void Build8() => Build(8, true);

    // for batchmode: -executeMethod ParamroomMeasureBuilder.BuildBatch
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
        var boardShader = Shader.Find("Paramroom/MeasureBoard");
        var loopShader = Shader.Find("Paramroom/LoopCounter");
        if (boardShader == null || loopShader == null) throw new Exception("Paramroom shaders not found (import Assets/ParamroomMeasure/Shaders)");

        // RenderTextures
        RenderTexture MakeRT(string name)
        {
            var desc = new RenderTextureDescriptor(4, 4, RenderTextureFormat.ARGB32, 0) { sRGB = false, msaaSamples = 1, useMipMap = false, autoGenerateMips = false };
            var rt = new RenderTexture(desc) { name = name, filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, antiAliasing = 1 };
            return CreateOrReplace(rt, $"{Gen}/{name}.renderTexture");
        }
        var rtA = MakeRT("ParamroomLoopA");
        var rtB = MakeRT("ParamroomLoopB");

        // Materials
        var boardMat = CreateOrReplace(new Material(boardShader) { name = "ParamroomBoard" }, $"{Gen}/ParamroomBoard.mat");
        boardMat.SetFloat("_ByteCount", byteCount);
        boardMat.SetTexture("_LoopTex", withLoop ? rtA : null);
        var matA = CreateOrReplace(new Material(loopShader) { name = "ParamroomLoopA" }, $"{Gen}/ParamroomLoopA.mat");
        matA.SetTexture("_Src", rtB); matA.SetFloat("_Far", FarA);
        var matB = CreateOrReplace(new Material(loopShader) { name = "ParamroomLoopB" }, $"{Gen}/ParamroomLoopB.mat");
        matB.SetTexture("_Src", rtA); matB.SetFloat("_Far", FarB);

        // Hierarchy
        var root = new GameObject("ParamroomMeasure");
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
            children.Add(new ChildMotion { motion = ConstantClip($"Paramroom_Set_P{i}", "Board", typeof(MeshRenderer), $"material._P{i}", 1), directBlendParameter = $"D{i}", timeScale = 1 });
        children.Add(new ChildMotion { motion = ConstantClip("Paramroom_Set_IsLocal", "Board", typeof(MeshRenderer), "material._IsLocal", 1), directBlendParameter = "IsLocal", timeScale = 1 });
        children.Add(new ChildMotion { motion = ConstantClip("Paramroom_Set_IsOnFriendsList", "Board", typeof(MeshRenderer), "material._IsOnFriendsList", 1), directBlendParameter = "IsOnFriendsList", timeScale = 1 });
        // Base child, always weight 1 (Paramroom_One): writes 0 to every data property (and enables the loop cameras).
        // Without it, a Direct blend tree child whose weight parameter is 0 is skipped and the material property
        // keeps its previous value instead of becoming 0 (observed in VRChat 2026-09-17: zero bytes stayed stale).
        // With the base child the property is always written: value = 1 * 0 + D_i * 1 = D_i.
        {
            var baseClip = new AnimationClip { name = "Paramroom_Base" };
            var zero = new AnimationCurve(new Keyframe(0, 0), new Keyframe(1f / 60f, 0));
            for (int i = 0; i < byteCount; i++)
                AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve("Board", typeof(MeshRenderer), $"material._P{i}"), zero);
            AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve("Board", typeof(MeshRenderer), "material._IsLocal"), zero);
            AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve("Board", typeof(MeshRenderer), "material._IsOnFriendsList"), zero);
            if (withLoop)
                foreach (var cam in new[] { "Loop/CamA", "Loop/CamB" })
                    AnimationUtility.SetEditorCurve(baseClip, EditorCurveBinding.FloatCurve(cam, typeof(Camera), "m_Enabled"), new AnimationCurve(new Keyframe(0, 1), new Keyframe(1f / 60f, 1)));
            CreateOrReplace(baseClip, $"{Gen}/Paramroom_Base.anim");
            children.Add(new ChildMotion { motion = baseClip, directBlendParameter = "Paramroom_One", timeScale = 1 });
        }

        // Controller
        var ctrlPath = $"{Gen}/ParamroomMeasure_FX.controller";
        if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(ctrlPath) != null) AssetDatabase.DeleteAsset(ctrlPath);
        var ctrl = AnimatorController.CreateAnimatorControllerAtPath(ctrlPath);
        for (int i = 0; i < byteCount; i++) ctrl.AddParameter($"D{i}", AnimatorControllerParameterType.Float);
        ctrl.AddParameter("IsLocal", AnimatorControllerParameterType.Float);
        ctrl.AddParameter("IsOnFriendsList", AnimatorControllerParameterType.Float);
        ctrl.AddParameter(new AnimatorControllerParameter { name = "Paramroom_One", type = AnimatorControllerParameterType.Float, defaultFloat = 1 });
        var tree = new BlendTree { name = "ParamroomDirect", blendType = BlendTreeType.Direct, useAutomaticThresholds = false, hideFlags = HideFlags.HideInHierarchy };
        tree.children = children.ToArray();
        AssetDatabase.AddObjectToAsset(tree, ctrl);
        var treeSo = new SerializedObject(tree);
        var norm = treeSo.FindProperty("m_NormalizedBlendValues");
        if (norm != null) { norm.boolValue = false; treeSo.ApplyModifiedPropertiesWithoutUndo(); }
        var sm = ctrl.layers[0].stateMachine;
        var state = sm.AddState("ParamroomRun");
        state.motion = tree;
        state.writeDefaultValues = true;
        sm.defaultState = state;
        var layers = ctrl.layers;
        layers[0].name = "ParamroomMeasure";
        layers[0].defaultWeight = 1;
        ctrl.layers = layers;
        EditorUtility.SetDirty(ctrl);

        // Modular Avatar components
        ParamroomModularAvatar.AddMergeAnimator(root, ctrl);
        ParamroomModularAvatar.AddParameters(root, byteCount);

        var prefabPath = $"{Root}/ParamroomMeasure.prefab";
        PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
        UnityEngine.Object.DestroyImmediate(root);
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        Debug.Log($"[Paramroom] built {prefabPath} ({byteCount} Int = {byteCount * 8} bits, loop={withLoop})");
    }
}

public static class ParamroomMeasureShaderCheck
{
    // batchmode (with graphics): -executeMethod ParamroomMeasureShaderCheck.Run
    public static void Run()
    {
        int errors = 0;
        foreach (var name in new[] { "Paramroom/MeasureBoard", "Paramroom/LoopCounter" })
        {
            var s = Shader.Find(name);
            if (s == null) { Debug.LogError($"[Paramroom] shader missing: {name}"); errors++; continue; }
            var msgs = ShaderUtil.GetShaderMessages(s);
            foreach (var m in msgs) Debug.Log($"[Paramroom] {name}: {m.severity} line {m.line}: {m.message}");
            if (ShaderUtil.ShaderHasError(s)) errors++;
            Debug.Log($"[Paramroom] {name}: hasError={ShaderUtil.ShaderHasError(s)} supported={s.isSupported}");
        }
        EditorApplication.Exit(errors == 0 ? 0 : 1);
    }
}

public static class ParamroomMeasureRenderTest
{
    // batchmode (with graphics): -executeMethod ParamroomMeasureRenderTest.Run -paramroomOut <dir>
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
        int oi = Array.IndexOf(args, "-paramroomOut");
        string outDir = oi >= 0 ? args[oi + 1] : "ParamroomRenderTest";
        System.IO.Directory.CreateDirectory(outDir);
        try
        {
            var boardMat = new Material(Shader.Find("Paramroom/MeasureBoard"));
            var loopShader = Shader.Find("Paramroom/LoopCounter");
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
            Debug.Log("[Paramroom] render test written to " + outDir);
            EditorApplication.Exit(0);
        }
        catch (Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
    }
}

public static class ParamroomMeasureAnimatorTest
{
    // batchmode: -executeMethod ParamroomMeasureAnimatorTest.Run
    // Drives the generated FX controller with a plain Animator (no VRChat/MA) and reads the material properties
    // back from the renderer's property block, for packets containing zero bytes. Also runs the same test with the
    // base child removed to reproduce the "zero byte keeps previous value" behaviour.
    public static void Run()
    {
        int failures = 0;
        try
        {
            ParamroomMeasureBuilder.Build(32, true);
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/ParamroomMeasure/ParamroomMeasure.prefab");
            var ctrl = AssetDatabase.LoadAssetAtPath<AnimatorController>("Assets/ParamroomMeasure/Generated/ParamroomMeasure_FX.controller");
            failures += RunCase("with base child", prefab, ctrl, expectStale: false);

            // variant without the base child
            var copyPath = "Assets/ParamroomMeasure/Generated/ParamroomMeasure_FX_nobase.controller";
            AssetDatabase.CopyAsset("Assets/ParamroomMeasure/Generated/ParamroomMeasure_FX.controller", copyPath);
            var noBase = AssetDatabase.LoadAssetAtPath<AnimatorController>(copyPath);
            var tree = (BlendTree)noBase.layers[0].stateMachine.defaultState.motion;
            tree.children = tree.children.Where(c => c.directBlendParameter != "Paramroom_One").ToArray();
            // NOTE: plain Unity did not reproduce the stale-zero behaviour seen in VRChat (2026-09-17); this case is
            // informational only. The base child makes the property written every frame regardless of the cause.
            RunCase("without base child (old, informational)", prefab, noBase, expectStale: false);
        }
        catch (Exception e) { Debug.LogException(e); failures++; }
        Debug.Log($"[Paramroom] animator test failures={failures}");
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
            Debug.Log($"[Paramroom] {label} step {step}: set D0={v0} D5={v5} -> _P0={r0} _P5={r5} {(ok ? "OK" : "MISMATCH")}");
            if (!ok) bad++;
        }
        UnityEngine.Object.DestroyImmediate(go);
        bool pass = expectStale ? bad > 0 : bad == 0;
        Debug.Log($"[Paramroom] {label}: {(pass ? "PASS" : "FAIL")} (mismatching steps {bad}, expectStale={expectStale})");
        return pass ? 0 : 1;
    }
}
