// Paramroom local transport probe - screen overlay with the statistics, read back from a screenshot.
// Drawn only in the normal view (not in mirrors or the photo camera), and the object is only enabled for the wearer.
//   upper-left rectangle: 16 control words as 32 black/white cells each (MSB left), inside a one-cell frame
//     (top and bottom frame rows alternate white/black starting white; left and right columns are white)
//   lower-left rectangle: chunk map, 64 x 32 chunks (row-major, chunk 0 top-left): white = present and correct,
//     grey = present but not the test pattern, black = missing
Shader "Paramroom/LocalHud"
{
    Properties
    {
        _Atlas ("Atlas", 2D) = "black" {}
        _StoreRows ("Store rows", Float) = 256
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

            Texture2D<float4> _Atlas;
            float _StoreRows, _Show;
            float _VRChatCameraMode, _VRChatMirrorMode;
            static const uint CHUNKS_PER_ROW = 8;

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

            // the mesh is one quad; uv 0..1. Screen rectangle x in [-0.95, -0.15], y in [-0.95, 0.95] (clip space)
            v2f vert (appdata v)
            {
                v2f o;
                o.uv = v.uv;
                if (_Show < 0.5 || _VRChatCameraMode != 0 || _VRChatMirrorMode != 0) { o.pos = float4(0, 0, -10, 1); return o; }
                float x = lerp(-0.95, -0.15, v.uv.x), y = lerp(-0.95, 0.95, v.uv.y);
                o.pos = float4(x, y * _ProjectionParams.x, 0.5, 1);
                return o;
            }

            uint Word(uint x, uint y)
            {
                float4 t = round(_Atlas.Load(int3(x, y, 0)) * 255.0);
                return ((uint)t.r << 24) | ((uint)t.g << 16) | ((uint)t.b << 8) | (uint)t.a;
            }

            float4 frag (v2f i) : SV_Target
            {
                // uv.y = 1 is the top of the rectangle
                float ty = 1 - i.uv.y;
                uint storeRows = (uint)_StoreRows, ctrlY = storeRows + 1;
                if (ty < 0.5)
                {
                    // statistics: 34 x 18 cells
                    uint cx = (uint)(i.uv.x * 34), cy = (uint)(ty / 0.5 * 18);
                    if (cy == 0 || cy == 17) return (cx & 1) == 0 ? 1 : 0;
                    if (cx == 0 || cx == 33) return 1;
                    uint w = Word(cy - 1, ctrlY);
                    return ((w >> (31 - (cx - 1))) & 1) ? 1 : 0;
                }
                if (ty < 0.52) return float4(0.2, 0.2, 0.2, 1);
                // chunk map
                uint mx = (uint)(i.uv.x * 64), my = (uint)((ty - 0.52) / 0.48 * 32);
                uint c = my * 64 + mx;
                if (c >= storeRows * CHUNKS_PER_ROW) return float4(0.1, 0, 0, 1);
                uint m = Word((c % CHUNKS_PER_ROW) * 32, c / CHUNKS_PER_ROW);
                if ((m >> 31) == 0) return 0;
                return ((m >> 30) & 1) ? 1 : 0.5;
            }
            ENDCG
        }
    }
}
