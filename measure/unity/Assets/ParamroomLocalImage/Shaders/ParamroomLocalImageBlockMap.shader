// Paramroom local image - decode pass 1: where does each block start (docs/research/13, reference sim/local/lpic.js
// decode "stage A"). One texel per block i (i = 3 * (by * bw + bx) + comp), row-major in a 256-wide target:
//   r = chunk, g = bit offset of the block in the chunk's stream, b = absolute DC (quantised), a = 1 found / 0 not
// The chunk is found by binary search on the chunks' first block numbers, then the chunk is parsed from its start up to
// the block (the DC prediction restarts at every chunk, so the DC is summed on the way).
Shader "Paramroom/LocalImageBlockMap"
{
    Properties
    {
        _Store ("Store atlas", 2D) = "black" {}
        _Far ("Loop camera far plane", Float) = 0.0421
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
            float _Far;

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; };

            v2f vert (appdata v)
            {
                v2f o;
                if (abs(_ProjectionParams.z - _Far) > 0.0005 || DecodePhase() != 0) { o.pos = float4(0, 0, -10, 1); return o; }
                float2 p = v.uv * 2 - 1;
                o.pos = float4(p.x, p.y * _ProjectionParams.x, 0.5, 1);
                return o;
            }

            float4 frag (v2f i) : SV_Target
            {
                uint blk = (uint)i.pos.y * 256 + (uint)i.pos.x;
                uint bw = (ImageW() + 7) / 8, bh = (ImageH() + 7) / 8;
                if (blk >= 3 * bw * bh) return 0;
                uint lo = 1, hi = ChunkCount() - 1;
                while (lo < hi)
                {
                    uint mid = (lo + hi + 1) / 2;
                    if (FirstBlock(mid) <= blk) lo = mid; else hi = mid - 1;
                }
                uint c = lo, first = FirstBlock(c);
                if (blk < first || blk >= first + BlockCount(c)) return 0;
                uint p = 0;
                int dc = 0;
                for (uint j = first; j < blk; j++)
                {
                    int d = SkipBlock(c, p, j % 3 ? 1 : 0);
                    if (j % 3 == blk % 3) dc += d;
                }
                return float4(c, p, dc, 1);
            }
            ENDCG
        }
    }
}
