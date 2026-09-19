// Paramroom local image - decode pass 3: horizontal inverse DCT and YCbCr -> RGB, one band per frame, into the image
// (docs/research/13, reference sim/local/lpic.js decode "stage C2"). The quad covers only this frame's band of rows; the
// image texture (sRGB values, ARGB32) keeps everything else, and the whole picture once the decode has finished.
Shader "Paramroom/LocalImageIdctH"
{
    Properties
    {
        _Store ("Store atlas", 2D) = "black" {}
        _Band ("Band texture (vertical pass)", 2D) = "black" {}
        _Far ("Loop camera far plane", Float) = 0.0425
        _ImageSize ("Image texture size", Float) = 1024
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" "Queue"="Geometry" "VRCFallback"="Hidden" }
        Cull Off ZWrite Off ZTest Always
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 5.0
            #include "UnityCG.cginc"
            #include "ParamroomLocalImageCommon.cginc"
            Texture2D<float4> _Band;
            float _Far, _ImageSize;

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; nointerpolation int band : TEXCOORD0; };

            v2f vert (appdata v)
            {
                v2f o;
                o.band = DecodePhase() - 1;
                if (abs(_ProjectionParams.z - _Far) > 0.0005 || o.band < 0) { o.pos = float4(0, 0, -10, 1); return o; }
                // only the band's rows: texel rows [b * BAND_ROWS, (b + 1) * BAND_ROWS), row 0 at the top (as SV_Position)
                float y0 = o.band * BAND_ROWS, y1 = y0 + BAND_ROWS;
                float y = lerp(y1, y0, v.uv.y);   // uv.y = 1 -> y0
                float yc = 1 - y / _ImageSize * 2;
                o.pos = float4(v.uv.x * 2 - 1, yc, 0.5, 1);
                return o;
            }

            float frac255(float v) { return clamp(floor(v + 0.5), 0, 255) / 255.0; }

            float4 frag (v2f i) : SV_Target
            {
                uint X = (uint)i.pos.x, Y = (uint)i.pos.y;
                if (X >= ImageW() || Y >= ImageH()) return float4(0, 0, 0, 1);
                uint bx = X / 8, x = X % 8, row = Y - (uint)i.band * BAND_ROWS;
                float3 s = 0;
                for (uint u = 0; u < 8; u++) s += COS8[x * 8 + u] * _Band.Load(int3(bx * 8 + u, row, 0)).rgb;
                float yv = s.x + 128, cb = s.y + 128, cr = s.z + 128;
                float r = yv + 1.402 * (cr - 128);
                float g = yv - 0.344136 * (cb - 128) - 0.714136 * (cr - 128);
                float b = yv + 1.772 * (cb - 128);
                return float4(frac255(r), frac255(g), frac255(b), 1);
            }
            ENDCG
        }
    }
}
