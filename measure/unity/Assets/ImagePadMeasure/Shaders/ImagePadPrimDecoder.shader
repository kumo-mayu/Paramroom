// ImagePad primitive-shape decoder (prototype) - camera-loop state machine.
//
// Packet (wire, MSB first, B = 8 * _ByteCount bits, bytes in _P0.._P31 = synced Int parameters):
//   [epoch 2][unit id _U][payload]   (see sim/codecs/prim.js, layout s=1, rotated ellipses)
//   unit 0 : [bg RGB565 16][_K0 primitives]     unit i>=1 : [_K primitives]
//   primitive: cx(_CB) cy(_CB) rx(_RB) ry(_RB) theta(_AB) r(_CR) g(_CG) b(_CBL) alpha(_ABITS)
// Epoch 0 is ignored (transient all-zero parameters). A new non-zero epoch clears the state.
//
// State atlas (RGBAHalf, 512 x 288, double buffered: this pass reads _Src = the other buffer):
//   work canvas     x [0,256)   y [0,256)   canvas being redrawn, _BatchSize primitives per pass
//   display canvas  x [256,512) y [0,256)   last completed canvas (what the board shows)
//   primitive store y [256,272) texel index t = 2*j + h (h = 0/1): bytes of primitive j's bit field
//                   (4 bytes per texel, value 0..255 exact in half); present flag = byte 7 bit 0
//   control         y = 280: x0 = pass counter (mod batch count), x1 = epoch, x2 = bg present, x3..5 = bg RGB 0..1
// Every texel only depends on the previous buffer and the current packet => idempotent, order independent.
Shader "ImagePad/PrimDecoder"
{
    Properties
    {
        _Src ("Source atlas (other buffer)", 2D) = "black" {}
        _Far ("Loop camera far plane", Float) = 0.0217
        _ByteCount ("Byte Count", Float) = 32
        _U ("Unit id bits", Float) = 8
        _K ("Primitives per unit", Float) = 4
        _K0 ("Primitives in unit 0", Float) = 3
        _NPrims ("Max primitives", Float) = 1003
        _CB ("Centre bits", Float) = 9
        _RB ("Radius bits", Float) = 8
        _AB ("Angle bits", Float) = 6
        _CR ("Red bits", Float) = 5
        _CG ("Green bits", Float) = 6
        _CBL ("Blue bits", Float) = 5
        _ABITS ("Alpha bits", Float) = 2
        _R ("Canvas resolution", Float) = 256
        _BatchSize ("Primitives per pass", Float) = 32
        _P0 ("P0", Float) = 0
        _P1 ("P1", Float) = 0
        _P2 ("P2", Float) = 0
        _P3 ("P3", Float) = 0
        _P4 ("P4", Float) = 0
        _P5 ("P5", Float) = 0
        _P6 ("P6", Float) = 0
        _P7 ("P7", Float) = 0
        _P8 ("P8", Float) = 0
        _P9 ("P9", Float) = 0
        _P10 ("P10", Float) = 0
        _P11 ("P11", Float) = 0
        _P12 ("P12", Float) = 0
        _P13 ("P13", Float) = 0
        _P14 ("P14", Float) = 0
        _P15 ("P15", Float) = 0
        _P16 ("P16", Float) = 0
        _P17 ("P17", Float) = 0
        _P18 ("P18", Float) = 0
        _P19 ("P19", Float) = 0
        _P20 ("P20", Float) = 0
        _P21 ("P21", Float) = 0
        _P22 ("P22", Float) = 0
        _P23 ("P23", Float) = 0
        _P24 ("P24", Float) = 0
        _P25 ("P25", Float) = 0
        _P26 ("P26", Float) = 0
        _P27 ("P27", Float) = 0
        _P28 ("P28", Float) = 0
        _P29 ("P29", Float) = 0
        _P30 ("P30", Float) = 0
        _P31 ("P31", Float) = 0
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

            Texture2D<float4> _Src;
            float _Far, _ByteCount, _U, _K, _K0, _NPrims, _CB, _RB, _AB, _CR, _CG, _CBL, _ABITS, _R, _BatchSize;
            float _P0, _P1, _P2, _P3, _P4, _P5, _P6, _P7, _P8, _P9, _P10, _P11, _P12, _P13, _P14, _P15;
            float _P16, _P17, _P18, _P19, _P20, _P21, _P22, _P23, _P24, _P25, _P26, _P27, _P28, _P29, _P30, _P31;

            static const uint ATLAS_W = 512;
            static const uint STORE_Y = 256;
            static const uint CTRL_Y = 280;

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; };

            v2f vert (appdata v)
            {
                v2f o;
                // Only the loop camera (unique far plane) draws this quad, as a full-viewport rectangle.
                if (abs(_ProjectionParams.z - _Far) > 0.0005) { o.pos = float4(0, 0, -10, 1); return o; }
                float2 p = v.uv * 2 - 1;
                o.pos = float4(p.x, p.y * _ProjectionParams.x, 0.5, 1);
                return o;
            }

            static uint g_pk[32];
            void LoadPacket()
            {
                float p[32] = { _P0, _P1, _P2, _P3, _P4, _P5, _P6, _P7, _P8, _P9, _P10, _P11, _P12, _P13, _P14, _P15,
                                _P16, _P17, _P18, _P19, _P20, _P21, _P22, _P23, _P24, _P25, _P26, _P27, _P28, _P29, _P30, _P31 };
                for (uint i = 0; i < 32; i++) g_pk[i] = (uint)clamp(round(p[i]), 0, 255);
            }
            // read n (<= 24) bits starting at wire bit offset off
            uint PacketBits(uint off, uint n)
            {
                uint v = 0;
                for (uint i = 0; i < n; i++)
                {
                    uint b = off + i;
                    v = (v << 1) | ((g_pk[b >> 3] >> (7 - (b & 7))) & 1);
                }
                return v;
            }
            float4 Load(uint x, uint y) { return _Src.Load(int3(x, y, 0)); }

            // A stored primitive = 64-bit slot (hi = bytes 0..3, lo = bytes 4..7), fields MSB-first from bit 0.
            uint Field(uint hi, uint lo, uint off, uint n)
            {
                // bits [off, off+n) of the 64-bit value hi:lo (n <= 16)
                uint v;
                if (off + n <= 32) v = (hi >> (32 - off - n));
                else if (off >= 32) v = (lo >> (64 - off - n));
                else v = (hi << (off + n - 32)) | (lo >> (64 - off - n));
                return v & ((1u << n) - 1);
            }
            uint Word(float4 t) { return ((uint)round(t.r) << 24) | ((uint)round(t.g) << 16) | ((uint)round(t.b) << 8) | (uint)round(t.a); }

            // blend primitive j onto colour c at canvas pixel (x, y)
            float3 DrawPrim(uint j, float3 c, float x, float y)
            {
                uint t = 2 * j;
                uint hi = Word(Load(t % ATLAS_W, STORE_Y + t / ATLAS_W));
                uint lo = Word(Load((t + 1) % ATLAS_W, STORE_Y + (t + 1) / ATLAS_W));
                if ((lo & 1) == 0) return c; // not present
                uint cb = (uint)_CB, rb = (uint)_RB, ab = (uint)_AB, crb = (uint)_CR, cgb = (uint)_CG, cbb = (uint)_CBL, abits = (uint)_ABITS;
                uint o = 0;
                float cmax = (float)((1u << cb) - 1), rN = (float)(1u << rb), aN = (float)(1u << ab);
                float cx = Field(hi, lo, o, cb) / cmax * _R; o += cb;
                float cy = Field(hi, lo, o, cb) / cmax * _R; o += cb;
                float rx = max(0.5, _R / 2 * pow((Field(hi, lo, o, rb) + 1) / rN, 2)); o += rb;
                float ry = max(0.5, _R / 2 * pow((Field(hi, lo, o, rb) + 1) / rN, 2)); o += rb;
                float th = Field(hi, lo, o, ab) / aN * UNITY_PI; o += ab;
                float dx = x + 0.5 - cx, dy = y + 0.5 - cy;
                float cs = cos(th), sn = sin(th);
                float u = dx * cs + dy * sn, v = dy * cs - dx * sn;
                if (u * u / (rx * rx) + v * v / (ry * ry) > 1) return c;
                float r = Field(hi, lo, o, crb) * 255.0 / ((1u << crb) - 1); o += crb;
                float g = Field(hi, lo, o, cgb) * 255.0 / ((1u << cgb) - 1); o += cgb;
                float b = Field(hi, lo, o, cbb) * 255.0 / ((1u << cbb) - 1); o += cbb;
                float a = (Field(hi, lo, o, abits) + 1) / (float)(1u << abits);
                return c * (1 - a) + float3(r, g, b) * a;
            }

            float4 frag (v2f i) : SV_Target
            {
                uint px = (uint)i.pos.x, py = (uint)i.pos.y;
                LoadPacket();
                uint unitBits = (uint)_U, k = (uint)_K, k0 = (uint)_K0, n = (uint)_NPrims;
                uint primBits = 2 * (uint)_CB + 2 * (uint)_RB + (uint)_AB + (uint)_CR + (uint)_CG + (uint)_CBL + (uint)_ABITS;
                uint nBatches = (n + (uint)_BatchSize - 1) / (uint)_BatchSize;

                // ---- packet
                uint epoch = PacketBits(0, 2);
                uint storedEpoch = (uint)round(Load(1, CTRL_Y).r);
                bool reset = epoch != 0 && epoch != storedEpoch;
                uint unitId = PacketBits(2, unitBits);

                // ---- control row
                if (py == CTRL_Y)
                {
                    float4 prev = Load(px, py);
                    if (px == 0) return float4(fmod(round(prev.r) + 1, nBatches), 0, 0, 1);
                    if (px == 1) return float4(epoch != 0 ? epoch : storedEpoch, 0, 0, 1);
                    if (px == 2)
                    {
                        if (reset) return float4(0, 0, 0, 1);
                        if (epoch != 0 && unitId == 0) return float4(1, 0, 0, 1);
                        return prev;
                    }
                    if (px == 3)
                    {
                        if (reset) return float4(0.5, 0.5, 0.5, 1);
                        if (epoch != 0 && unitId == 0)
                        {
                            uint bg = PacketBits(2 + unitBits, 16);
                            return float4(((bg >> 11) & 31) / 31.0 * 255, ((bg >> 5) & 63) / 63.0 * 255, (bg & 31) / 31.0 * 255, 1);
                        }
                        return prev;
                    }
                    return float4(0, 0, 0, 1);
                }

                // ---- primitive store
                if (py >= STORE_Y && py < STORE_Y + 16)
                {
                    uint t = (py - STORE_Y) * ATLAS_W + px;
                    uint j = t / 2, h = t % 2;
                    if (reset || j >= n) return float4(0, 0, 0, 0);
                    float4 prev = Load(px, py);
                    if (epoch == 0) return prev;
                    // where is primitive j in the packet (if at all)
                    uint off = 0; bool here = false;
                    if (j < k0) { if (unitId == 0) { here = true; off = 2 + unitBits + 16 + j * primBits; } }
                    else if (k > 0)
                    {
                        uint uid = 1 + (j - k0) / k, slot = (j - k0) % k;
                        if (unitId == uid) { here = true; off = 2 + unitBits + slot * primBits; }
                    }
                    if (!here) return prev;
                    float4 o;
                    for (uint c = 0; c < 4; c++)
                    {
                        uint byteIdx = h * 4 + c;       // byte 0..7 of the 64-bit slot
                        uint startBit = byteIdx * 8;    // bit index within the primitive field
                        uint v = 0;
                        if (startBit < primBits)
                        {
                            uint nb = min(8u, primBits - startBit);
                            v = PacketBits(off + startBit, nb) << (8 - nb);
                        }
                        if (byteIdx == 7) v |= 1; // present flag (bit 63; primBits <= 63)
                        o[c] = v;
                    }
                    return o;
                }

                // ---- canvases
                if (py < 256)
                {
                    uint counterPrev = (uint)round(Load(0, CTRL_Y).r);
                    uint s = counterPrev % nBatches;
                    if (px >= 256)
                    {
                        // display: when the previous pass finished a full redraw (s wrapped to 0), take the work canvas
                        if (reset) return float4(0.5, 0.5, 0.5, 1);
                        return s == 0 ? Load(px - 256, py) : Load(px, py);
                    }
                    float x = px * _R / 256.0, y = py * _R / 256.0;
                    float3 c;
                    if (s == 0 || reset)
                    {
                        float bgp = Load(2, CTRL_Y).r;
                        c = bgp > 0.5 ? Load(3, CTRL_Y).rgb : float3(128, 128, 128);
                    }
                    else c = Load(px, py).rgb;
                    if (reset) return float4(c, 1);
                    uint j0 = s * (uint)_BatchSize, j1 = min(n, j0 + (uint)_BatchSize);
                    for (uint j = j0; j < j1; j++) c = DrawPrim(j, c, x, y);
                    return float4(c, 1);
                }
                return float4(0, 0, 0, 1);
            }
            ENDCG
        }
    }
}
