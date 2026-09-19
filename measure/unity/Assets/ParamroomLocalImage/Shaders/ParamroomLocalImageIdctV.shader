// Paramroom local image - decode pass 2: coefficients and the vertical inverse DCT, one band of BAND_ROWS image rows
// per frame (docs/research/13, reference sim/local/lpic.js decode "stage C1").
// Target texel (bx * 8 + u, row) of band b holds, for image row Y = b * BAND_ROWS + row (by = Y / 8, y = Y % 8):
//   t_comp(u, y) = sum_v COS8[y * 8 + v] * F_comp(u, v)     for comp = Y, Cb, Cr in r, g, b
// Each texel parses its three blocks from the block map's offset and keeps the 8 coefficients of column u.
Shader "Paramroom/LocalImageIdctV"
{
    Properties
    {
        _Store ("Store atlas", 2D) = "black" {}
        _BlockMap ("Block map", 2D) = "black" {}
        _Far ("Loop camera far plane", Float) = 0.0423
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
            Texture2D<float4> _BlockMap;
            float _Far;

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; nointerpolation int band : TEXCOORD0; };

            v2f vert (appdata v)
            {
                v2f o;
                o.band = DecodePhase() - 1;
                if (abs(_ProjectionParams.z - _Far) > 0.0005 || o.band < 0) { o.pos = float4(0, 0, -10, 1); return o; }
                float2 p = v.uv * 2 - 1;
                o.pos = float4(p.x, p.y * _ProjectionParams.x, 0.5, 1);
                return o;
            }

            float4 frag (v2f i) : SV_Target
            {
                uint px = (uint)i.pos.x, Y = (uint)i.band * BAND_ROWS + (uint)i.pos.y;
                uint bw = (ImageW() + 7) / 8, bh = (ImageH() + 7) / 8;
                uint bx = px / 8, u = px % 8, by = Y / 8, y = Y % 8;
                if (bx >= bw || by >= bh) return 0;
                uint quality = Quality();
                float3 t3 = 0;
                [unroll] for (uint comp = 0; comp < 3; comp++)
                {
                    uint blk = 3 * (by * bw + bx) + comp;
                    float4 m = _BlockMap.Load(int3(blk % 256, blk / 256, 0));
                    uint c = (uint)m.r, p = (uint)m.g, t = comp ? 1 : 0;
                    int dc = (int)m.b;
                    float F[8] = { 0, 0, 0, 0, 0, 0, 0, 0 };
                    uint len;
                    uint s = Huff(c, p, t, len); p += len;
                    int dcDiff = Extend(Peek(c, p, s), s); p += s;
                    if (u == 0) F[0] = (float)((dc + dcDiff) * (int)QStep(t, 0, quality));
                    for (uint k = 1; k < 64;)
                    {
                        uint a = Huff(c, p, 2 + t, len); p += len;
                        uint r = a >> 4, sz = a & 15;
                        if (sz == 0) { if (r == 15) { k += 16; continue; } break; }
                        k += r;
                        if (k < 64)
                        {
                            uint z = ZIGZAG[k];
                            if ((z & 7) == u) F[z >> 3] = (float)(Extend(Peek(c, p, sz), sz) * (int)QStep(t, z, quality));
                        }
                        p += sz; k++;
                    }
                    float acc = 0;
                    for (uint vv = 0; vv < 8; vv++) acc += COS8[y * 8 + vv] * F[vv];
                    t3[comp] = acc;
                }
                return float4(t3, 1);
            }
            ENDCG
        }
    }
}
