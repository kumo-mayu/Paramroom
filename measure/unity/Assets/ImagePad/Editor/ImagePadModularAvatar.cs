// Adds Modular Avatar components through reflection and SerializedObject, so the editor scripts compile in projects
// without Modular Avatar (and with any of its versions that keep these serialized field names).
// Used by the decoder prefab builder (ImagePadPrimBuilder) and the measurement prefab builder (ImagePadMeasure).
using System;
using System.Linq;
using UnityEditor;
using UnityEngine;

// The avatar parameter names. The prefix keeps them from colliding with other gimmicks ("D0" is a name anyone might
// use). Parameter names are not synced, so a longer name costs nothing in the 256 bit budget. The sender also accepts
// the plain D0.. of prefabs built before this, so those avatars keep working.
public static class ParamroomNames
{
    public const string Prefix = "Paramroom_";
    public static string Data(int i) => $"{Prefix}D{i}";
    public const string Format = Prefix + "Format";
}

public static class ImagePadModularAvatar
{
    internal static Type FindType(string fullName) =>
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

    // D0..D(n-1) synced Int; formatId > 0 also adds ImagePad_Format, a local-only (not synced, 0 sync bits) Int whose
    // default value tells the sender (via OSCQuery) which decoder variant the avatar has.
    internal static void AddParameters(GameObject root, int byteCount, int formatId = 0)
    {
        var t = FindType("nadena.dev.modular_avatar.core.ModularAvatarParameters");
        if (t == null) { Debug.LogWarning("[ImagePad] Modular Avatar not found: add D0..D(n-1) Int synced parameters manually."); return; }
        var c = root.AddComponent(t);
        var so = new SerializedObject(c);
        var list = Req(so, "parameters");
        var syncEnum = FindType("nadena.dev.modular_avatar.core.ParameterSyncType");
        int intSync = syncEnum != null ? (int)Enum.Parse(syncEnum, "Int") : 1;
        list.arraySize = byteCount + (formatId > 0 ? 1 : 0);
        for (int i = 0; i < list.arraySize; i++)
        {
            bool format = i == byteCount;
            var el = list.GetArrayElementAtIndex(i);
            Req(el, "nameOrPrefix").stringValue = format ? ParamroomNames.Format : ParamroomNames.Data(i);
            Req(el, "remapTo").stringValue = "";
            Req(el, "internalParameter").boolValue = false;
            Req(el, "isPrefix").boolValue = false;
            Req(el, "syncType").intValue = intSync;
            Req(el, "localOnly").boolValue = format;
            Req(el, "defaultValue").floatValue = format ? formatId : 0;
            Req(el, "saved").boolValue = false;
        }
        so.ApplyModifiedPropertiesWithoutUndo();
    }
}
