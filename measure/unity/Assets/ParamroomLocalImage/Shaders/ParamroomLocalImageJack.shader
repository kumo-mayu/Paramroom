// Paramroom local image - camera jack (docs/research/13): when VRChat renders its handheld camera / screenshot
// (_VRChatCameraMode != 0) and _Jack is on, the whole picture is covered by the decoded image, letterboxed on black.
// So a photo (and a Print made from it) shows the image. Only on the wearer's client (the object is enabled only for
// the wearer, and the image only exists there).
// Colour: the image holds sRGB values; VRChat renders in linear space, so they are converted back here and the camera's
// sRGB output reproduces them (post-processing of the world can still change them: unmeasured).
Shader "Paramroom/LocalImageJack"
{
    Properties
    {
        _Store ("Store atlas", 2D) = "black" {}
        _Image ("Image", 2D) = "black" {}
        _ImageSize ("Image texture size", Float) = 1024
        _Jack ("Jack the photo camera", Float) = 0
    }
    SubShader
    {
        Tags { "RenderType"="Overlay" "Queue"="Overlay+2000" "VRCFallback"="Hidden" "IgnoreProjector"="True" }
        Cull Off ZWrite Off ZTest Always
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 5.0
            #include "UnityCG.cginc"
            #include "ParamroomLocalImageCommon.cginc"
            Texture2D<float4> _Image;
            SamplerState sampler_linear_clamp;
            float _ImageSize, _Jack;
            float _VRChatCameraMode;

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; };

            v2f vert (appdata v)
            {
                v2f o;
                if (_Jack < 0.5 || _VRChatCameraMode == 0) { o.pos = float4(0, 0, -10, 1); return o; }
                float2 p = v.uv * 2 - 1;
                o.pos = float4(p.x, p.y * _ProjectionParams.x, 0.0001, 1);
                return o;
            }

            float3 SrgbToLinear(float3 c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }

            float4 frag (v2f i) : SV_Target
            {
                float W = ImageW(), H = ImageH();
                if (W == 0 || Ctrl(11) == 0) return float4(0, 0, 0, 1);
                // screen position with the top-left origin, in pixels of the camera's target. Rendering into a render
                // texture (the photo camera) Unity flips the projection (_ProjectionParams.x < 0) and SV_Position then
                // counts from the bottom of the final picture.
                float2 ss = _ScreenParams.xy;
                float2 sp = float2(i.pos.x, _ProjectionParams.x < 0 ? ss.y - i.pos.y : i.pos.y);
                float scale = min(ss.x / W, ss.y / H);
                float2 off = (ss - float2(W, H) * scale) / 2;
                float2 p = (sp - off) / scale;   // image pixels
                if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return float4(0, 0, 0, 1);
                return float4(SrgbToLinear(_Image.SampleLevel(sampler_linear_clamp, p / _ImageSize, 0).rgb), 1);
            }
            ENDCG
        }
    }
}
