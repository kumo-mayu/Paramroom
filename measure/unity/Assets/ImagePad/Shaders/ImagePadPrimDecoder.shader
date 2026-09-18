// ImagePad primitive-shape decoder (prototype) - camera-loop state machine.
//
// Packet (wire, MSB first, 8 * _ByteCount bits, bytes in _P0.._P(_ByteCount-1) = synced Int parameters, _ByteCount <= 32):
//   [epoch 2][unit id _U][payload]   (see sim/codecs/prim.js, layout s=1, rotated ellipses)
//   unit 0 : [bg RGB565 16][_K0 primitives]     unit i>=1 : [_K primitives]
//   primitive: cx(_CB) cy(_CB) rx(_RB) ry(_RB) theta(_AB) r(_CR) g(_CG) b(_CBL) alpha(_ABITS)
//
// Two kinds of content share these packets, chosen by the sender (see sim/codecs/qrmode.js):
//   mode 0 (picture): as above.
//   mode 1 (QR code): the slots hold one bit per QR module instead of a primitive, row by row, and unit 0's 16-bit
//     header holds [modules 8][reserved 8]. A canvas pixel is black when its module's bit is 1, white otherwise; a
//     module whose packet has not arrived stays white (a reader then says "unreadable" rather than reading it wrong).
//     A QR code of 25x25 fits in 3 packets, so it is complete in about 0.3 s.
//   The mode is the bit just before the aspect byte in every packet, and is accepted the same way (two passes agreeing).
// Epoch 0 is ignored (transient all-zero parameters). A new non-zero epoch clears the state.
//
// State atlas (RGBAHalf, double buffered: this pass reads _Src = the other buffer). C = _Canvas (256 or 512):
//   S = store rows = ceil(_StoreTexels / 2C) (2 texels per primitive; 8192 texels = 4096 primitives by default)
//   size 2C x (C + S + 16): C=256 -> 512 x 288, C=512 -> 1024 x 536 (5000 primitives: 1024 x 538)
//   work canvas     x [0,C)   y [0,C)   canvas being redrawn, _BatchSize primitives per pass
//   display canvas  x [C,2C)  y [0,C)   last completed canvas (what the board shows)
//   primitive store y [C, C+S)      texel index t = 2*j + h (h = 0/1): bytes of primitive j's bit field
//                   (4 bytes per texel, value 0..255 exact in half); present flag = byte 7 bit 0; <= 4096 primitives
//   control         y = CTRL = C + S + 8: x0 = batch counter s, x1 = epoch, x2 = bg present,
//                   x3 = bg RGB 0..255, x4 = accepted aspect code, x5 = aspect code of the previous valid packet,
//                   x6 = dirty (the store changed since the running/last redraw started),
//                   x7 = accepted mode (0 picture / 1 QR), x8 = mode of the previous valid packet
// Redraw on change: a redraw cycle (batches s = 0..nBatches-1) starts only when dirty is set; with nothing new the
// canvas passes just copy the previous texel (steady state costs almost nothing). A packet marks dirty only if it
// changes the store (a new unit, or different bytes), so repeated units do not trigger redraws.
// Aspect code = last packet byte (_P(_ByteCount-1), unit padding; sim/codecs/prim.js aspectCode, 0 = 1:1). It is accepted when two
// consecutive loop passes see the same value; reset -> 0. NOTE: a synced value is held for many passes (2 per frame,
// ~6 frames per packet), so this is only a one-pass delay, not protection against torn packets. Within an epoch every
// packet carries the same code, so a torn packet can only show the previous image's shape at an epoch change, for at
// most one packet (~100 ms) while the canvas is being reset anyway (VRChat test 2026-09-17, docs/measure).
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
        _R ("Primitive coordinate range", Float) = 256
        _Canvas ("Canvas texels (256 or 512)", Float) = 256
        _StoreTexels ("Primitive store texels (2 per primitive)", Float) = 8192
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
            float _Far, _ByteCount, _U, _K, _K0, _NPrims, _CB, _RB, _AB, _CR, _CG, _CBL, _ABITS, _R, _Canvas, _StoreTexels, _BatchSize;
            float _P0, _P1, _P2, _P3, _P4, _P5, _P6, _P7, _P8, _P9, _P10, _P11, _P12, _P13, _P14, _P15;
            float _P16, _P17, _P18, _P19, _P20, _P21, _P22, _P23, _P24, _P25, _P26, _P27, _P28, _P29, _P30, _P31;

            // atlas layout (set at the start of frag from _Canvas)
            static uint C, ATLAS_W, STORE_Y, STORE_ROWS, CTRL_Y;
            void InitLayout() { C = (uint)_Canvas; ATLAS_W = 2 * C; STORE_Y = C; STORE_ROWS = ((uint)_StoreTexels + ATLAS_W - 1) / ATLAS_W; CTRL_Y = C + STORE_ROWS + 8; }

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

            // QR mode: which colour does canvas pixel (px, py) have?
            // The modules sit in the same slots the primitives use (primBits bits per slot), so the store and the
            // packet handling are unchanged; only this lookup is different. White until the module's packet arrives.
            float3 QrPixel(uint px, uint py, uint C, uint unitBits, uint k, uint k0, uint primBits)
            {
                uint n = (uint)round(Load(9, CTRL_Y).r);        // modules per side, from unit 0's header
                if (n < 21u) return float3(255, 255, 255);
                uint cells = n + 8u;                            // 4 modules of white margin on each side
                uint cell = C / cells;
                if (cell < 1u) return float3(255, 255, 255);
                uint pad = (C - cell * cells) / 2u;
                if (px < pad || py < pad) return float3(255, 255, 255);
                uint cx = (px - pad) / cell, cy = (py - pad) / cell;
                if (cx < 4u || cy < 4u || cx >= 4u + n || cy >= 4u + n) return float3(255, 255, 255);
                uint idx = (cy - 4u) * n + (cx - 4u);
                uint slot = idx / primBits, off = idx % primBits;
                uint t = 2u * slot;
                uint hi = Word(Load(t % ATLAS_W, STORE_Y + t / ATLAS_W));
                uint lo = Word(Load((t + 1u) % ATLAS_W, STORE_Y + (t + 1u) / ATLAS_W));
                if ((lo & 1u) == 0u) return float3(255, 255, 255);   // that packet has not arrived
                return Field(hi, lo, off, 1u) != 0u ? float3(0, 0, 0) : float3(255, 255, 255);
            }

            // store texel h (0/1) of a primitive whose bit field starts at packet bit off
            float4 SlotTexel(uint off, uint h, uint primBits)
            {
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
            bool SlotDiffers(uint j, uint off, uint primBits)
            {
                uint t = 2 * j;
                for (uint h = 0; h < 2; h++)
                {
                    float4 a = SlotTexel(off, h, primBits), b = round(Load((t + h) % ATLAS_W, STORE_Y + (t + h) / ATLAS_W));
                    if (any(a != b)) return true;
                }
                return false;
            }
            float3 Bg565(uint bg) { return float3(((bg >> 11) & 31) / 31.0 * 255, ((bg >> 5) & 63) / 63.0 * 255, (bg & 31) / 31.0 * 255); }
            // does the current (valid) packet change the store / background?
            bool PacketChanges(uint unitId, uint unitBits, uint k, uint k0, uint n, uint primBits)
            {
                if (unitId == 0)
                {
                    if (Load(2, CTRL_Y).r < 0.5 || any(abs(Bg565(PacketBits(2 + unitBits, 16)) - Load(3, CTRL_Y).rgb) > 0.01)) return true;
                    for (uint j = 0; j < min(k0, n); j++) if (SlotDiffers(j, 2 + unitBits + 16 + j * primBits, primBits)) return true;
                    return false;
                }
                if (k == 0) return false;
                for (uint slot = 0; slot < k; slot++)
                {
                    uint j = k0 + (unitId - 1) * k + slot;
                    if (j >= n) break;
                    if (SlotDiffers(j, 2 + unitBits + slot * primBits, primBits)) return true;
                }
                return false;
            }

            float4 frag (v2f i) : SV_Target
            {
                uint px = (uint)i.pos.x, py = (uint)i.pos.y;
                InitLayout();
                LoadPacket();
                uint unitBits = (uint)_U, k = (uint)_K, k0 = (uint)_K0, n = (uint)_NPrims;
                uint lastByte = clamp((uint)_ByteCount, 1u, 32u) - 1;
                uint totalBits = 8u * clamp((uint)_ByteCount, 1u, 32u);
                uint modeBit = PacketBits(totalBits - 9u, 1u);   // the bit just before the aspect byte
                uint primBits = 2 * (uint)_CB + 2 * (uint)_RB + (uint)_AB + (uint)_CR + (uint)_CG + (uint)_CBL + (uint)_ABITS;
                uint batch = (uint)max(1.0, _BatchSize);   // guard: _BatchSize can be edited on the material
                uint nBatches = (n + batch - 1) / batch;

                // ---- packet
                uint epoch = PacketBits(0, 2);
                uint storedEpoch = (uint)round(Load(1, CTRL_Y).r);
                bool reset = epoch != 0 && epoch != storedEpoch;
                uint unitId = PacketBits(2, unitBits);
                uint sPrev = (uint)round(Load(0, CTRL_Y).r) % nBatches;
                bool dirtyPrev = Load(6, CTRL_Y).r > 0.5;
                bool drawing = !reset && (sPrev != 0 || dirtyPrev); // this pass draws batch sPrev

                // ---- control row
                if (py == CTRL_Y)
                {
                    float4 prev = Load(px, py);
                    if (px == 0) return float4(drawing ? (sPrev + 1) % nBatches : 0, 0, 0, 1);
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
                            return float4(Bg565(PacketBits(2 + unitBits, 16)), 1);
                        }
                        return prev;
                    }
                    if (px == 4)
                    {
                        if (epoch == 0) return prev;
                        uint seen = (uint)round(Load(5, CTRL_Y).r);
                        if (reset) return float4(0, 0, 0, 1);
                        return g_pk[lastByte] == seen ? float4(g_pk[lastByte], 0, 0, 1) : prev;
                    }
                    if (px == 5) return epoch != 0 ? float4(g_pk[lastByte], 0, 0, 1) : prev;
                    // mode, confirmed the same way as the aspect code: a value has to be seen twice in a row
                    if (px == 7)
                    {
                        if (epoch == 0) return prev;
                        uint seenMode = (uint)round(Load(8, CTRL_Y).r);
                        if (reset) return float4(modeBit, 0, 0, 1);
                        return modeBit == seenMode ? float4(modeBit, 0, 0, 1) : prev;
                    }
                    if (px == 8) return epoch != 0 ? float4(modeBit, 0, 0, 1) : prev;
                    // modules per side (QR mode). It shares unit 0's 16-bit header with the background colour, which
                    // the picture mode uses: only one of the two is meaningful, decided by the mode.
                    if (px == 9)
                    {
                        if (reset) return float4(0, 0, 0, 1);
                        if (epoch != 0 && unitId == 0) return float4(PacketBits(2 + unitBits, 8), 0, 0, 1);
                        return prev;
                    }
                    if (px == 6)
                    {
                        if (reset) return float4(1, 0, 0, 1);
                        bool changed = epoch != 0 && PacketChanges(unitId, unitBits, k, k0, n, primBits);
                        // starting a cycle consumes the flag; a change in this very pass is not yet visible to it
                        bool keep = (sPrev == 0 && dirtyPrev) ? false : dirtyPrev;
                        return float4((keep || changed) ? 1 : 0, 0, 0, 1);
                    }
                    return float4(0, 0, 0, 1);
                }

                // ---- primitive store
                if (py >= STORE_Y && py < STORE_Y + STORE_ROWS)
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
                    return SlotTexel(off, h, primBits);
                }

                // ---- canvases
                if (py < C)
                {
                    uint s = sPrev;
                    if (px >= C)
                    {
                        // display: at s == 0 the work canvas is complete (a redraw just finished, or idle)
                        if (reset) return float4(128, 128, 128, 1); // canvases hold 0..255 (the display shader divides by 255)
                        return s == 0 ? Load(px - C, py) : Load(px, py);
                    }
                    if (!reset && !drawing) return Load(px, py); // idle: nothing changed
                    // QR mode: the canvas is the code itself, drawn in one pass (a few hundred bits, not 4000 shapes)
                    if ((uint)round(Load(7, CTRL_Y).r) == 1u)
                    {
                        if (reset) return float4(255, 255, 255, 1);
                        return float4(QrPixel(px, py, C, unitBits, k, k0, primBits), 1);
                    }
                    float x = px * _R / C, y = py * _R / C;
                    float3 c;
                    if (s == 0 || reset)
                    {
                        float bgp = Load(2, CTRL_Y).r;
                        c = bgp > 0.5 ? Load(3, CTRL_Y).rgb : float3(128, 128, 128);
                    }
                    else c = Load(px, py).rgb;
                    if (reset) return float4(c, 1);
                    uint j0 = s * batch, j1 = min(n, j0 + batch);
                    for (uint j = j0; j < j1; j++) c = DrawPrim(j, c, x, y);
                    return float4(c, 1);
                }
                return float4(0, 0, 0, 1);
            }
            ENDCG
        }
    }
}
