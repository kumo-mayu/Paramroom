// Paramroom local image - the wearer's overlay (docs/research/13): the statistics as black/white cells in the upper half
// (same geometry as the probe's overlay, read by measure/osc/local-probe-read.js --image) and the decoded picture below.
// Only in the normal view (not mirrors, not the photo camera); the object is enabled only for the wearer.
Shader "Paramroom/LocalImageHud"
{
    Properties
    {
        _Store ("Store atlas", 2D) = "black" {}
        _Image ("Image", 2D) = "black" {}
        _ImageSize ("Image texture size", Float) = 1024
        _Show ("Show", Float) = 1
    }
    SubShader
    {
        Tags { "RenderType"="Overlay" "Queue"="Overlay+1000" "VRCFallback"="Hidden" "IgnoreProjector"="True" }
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
            float _ImageSize, _Show;
            float _VRChatCameraMode, _VRChatMirrorMode;

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

            v2f vert (appdata v)
            {
                v2f o;
                o.uv = v.uv;
                if (_Show < 0.5 || _VRChatCameraMode != 0 || _VRChatMirrorMode != 0) { o.pos = float4(0, 0, -10, 1); return o; }
                float x = lerp(-0.95, -0.15, v.uv.x), y = lerp(-0.95, 0.95, v.uv.y);
                o.pos = float4(x, y * _ProjectionParams.x, 0.5, 1);
                return o;
            }

            float3 SrgbToLinear(float3 c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }

            float4 frag (v2f i) : SV_Target
            {
                float ty = 1 - i.uv.y;   // 0 at the top of the rectangle
                if (ty < 0.5)
                {
                    uint cx = (uint)(i.uv.x * 34), cy = (uint)(ty / 0.5 * 18);
                    if (cy == 0 || cy == 17) return (cx & 1) == 0 ? 1 : 0;
                    if (cx == 0 || cx == 33) return 1;
                    uint w = Ctrl(cy - 1);
                    return ((w >> (31 - (cx - 1))) & 1) ? 1 : 0;
                }
                if (ty < 0.52) return float4(0.2, 0.2, 0.2, 1);
                // picture, fitted into the lower rectangle (its aspect on screen is unknown here: fit by texture units)
                float2 q = float2(i.uv.x, (ty - 0.52) / 0.48);
                float W = ImageW(), H = ImageH();
                if (W == 0 || Ctrl(11) == 0) return float4(0.1, 0.1, 0.1, 1);
                float s = max(W, H);
                float2 p = q * s;              // image pixels, top-left origin
                if (p.x >= W || p.y >= H) return 0;
                return float4(SrgbToLinear(_Image.SampleLevel(sampler_linear_clamp, p / _ImageSize, 0).rgb), 1);
            }
            ENDCG
        }
    }
}
