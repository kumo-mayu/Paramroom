// Paramroom QR-only decoder (docs/research/09 §6) - camera-loop state machine.
//
// The picture decoder cuts each packet into "one primitive" slots, so a packet that cannot hold a whole primitive
// (47..59 bits) has no layout at all. That is why the QR mode inside the picture formats needs 9..10 Int. A decoder
// that only ever shows a QR code does not need those slots, so it works with far fewer synced parameters.
//
// Packet (wire, MSB first, 8 * _ByteCount bits, bytes in _P0.._P(_ByteCount-1)):
//   [epoch 2][unit id _U][payload]
//   unit 0 : [version 6][cells...]      unit i : [cells...]        1 bit = 1 cell, row by row
// The three 8x8 corners (finder pattern + separator, 192 cells) are NOT sent: that shape is the same for every
// version, so this shader draws them. The number of skipped cells before (x, y) in row-major order has a closed form,
// so the index is plain arithmetic. Reference: sim/codecs/qronly.js, tools/Paramroom.Core/QrOnly.cs.
//
// Epoch 0 is ignored (transient all-zero parameters). A new non-zero epoch clears the grid.
//
// State atlas (RGBAHalf, double buffered: this pass reads _Src = the other buffer), M = _MaxSide (57 = version 10):
//   size 64 x (M + 1)
//   cells     y [0, M)   x [0, M)   r = 1 black, 0 white (a cell whose packet has not arrived stays white, so a
//                                   reader says "unreadable" rather than reading it wrong)
//   control   y = M      x0 = epoch, x1 = version (0 = not known yet),
//                        x2..x5 = the packet bytes the deciding pass saw last frame
// Every texel depends only on the previous buffer and the current packet => idempotent and order independent.
Shader "Paramroom/QrDecoder"
{
    Properties
    {
        _Src ("Source atlas (other buffer)", 2D) = "black" {}
        _Far ("Loop camera far plane", Float) = 0.0217
        _ByteCount ("Byte Count", Float) = 4
        _U ("Unit id bits", Float) = 8
        _Pay ("Cells per unit", Float) = 22
        _MaxSide ("Largest QR side (17 + 4 * version)", Float) = 57
        _Primary ("This is the deciding pass (camera A)", Float) = 0
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
            float _Far, _ByteCount, _U, _Pay, _MaxSide, _Primary;
            float _P0, _P1, _P2, _P3, _P4, _P5, _P6, _P7, _P8, _P9, _P10, _P11, _P12, _P13, _P14, _P15;

            static const uint HEAD = 6;     // version, 1..40 sent as 0..39
            static const uint CORNER = 8;   // finder 7x7 + separator

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

            static uint g_pk[16];
            void LoadPacket()
            {
                float p[16] = { _P0, _P1, _P2, _P3, _P4, _P5, _P6, _P7, _P8, _P9, _P10, _P11, _P12, _P13, _P14, _P15 };
                for (uint i = 0; i < 16; i++) g_pk[i] = (uint)clamp(round(p[i]), 0, 255);
            }
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

            // Torn packets (docs/research/10): VRChat can apply half an OSC bundle in one frame, so a packet may be
            // read as "front half new, back half old". Written to the grid it shows as a band of wrong cells until that
            // packet comes round again. Such a value is visible for a whole frame, so only the deciding pass (camera A)
            // takes packets, and only ones that were already there one frame earlier; the other pass copies.
            static const uint PREV_X = 2;   // control texels holding the bytes the deciding pass saw last frame
            float4 CurPacketTexel(uint i, uint nBytes)
            {
                uint b = i * 4;
                return float4(b + 0 < nBytes ? g_pk[b + 0] : 0, b + 1 < nBytes ? g_pk[b + 1] : 0,
                              b + 2 < nBytes ? g_pk[b + 2] : 0, b + 3 < nBytes ? g_pk[b + 3] : 0);
            }
            bool PacketHeldSinceLastFrame(uint nBytes, uint ctrlY)
            {
                uint texels = (nBytes + 3) / 4;
                for (uint i = 0; i < texels; i++)
                    if (any(abs(round(Load(PREV_X + i, ctrlY)) - CurPacketTexel(i, nBytes)) > 0.5)) return false;
                return true;
            }

            bool Skipped(uint n, uint x, uint y)
            {
                return (y < CORNER && (x < CORNER || x >= n - CORNER)) || (y >= n - CORNER && x < CORNER);
            }
            // how many skipped cells come before (x, y) in row-major order
            uint SkippedBefore(uint n, uint x, uint y)
            {
                uint s;
                if (y < CORNER) s = 16 * y;
                else if (y < n - CORNER) s = 16 * CORNER;
                else s = 16 * CORNER + CORNER * (y - (n - CORNER));
                if (y < CORNER) s += min(x, CORNER) + (x > n - CORNER ? x - (n - CORNER) : 0);
                else if (y >= n - CORNER) s += min(x, CORNER);
                return s;
            }
            // the finder pattern (with its separator) at the three corners
            bool Finder(uint n, uint x, uint y)
            {
                int u, v;
                if (y < CORNER && x < CORNER) { u = (int)x; v = (int)y; }
                else if (y < CORNER) { u = (int)x - ((int)n - 7); v = (int)y; }
                else { u = (int)x; v = (int)y - ((int)n - 7); }
                if (u < 0 || u > 6 || v < 0 || v > 6) return false;      // separator: white
                return u == 0 || u == 6 || v == 0 || v == 6 || (u >= 2 && u <= 4 && v >= 2 && v <= 4);
            }

            float4 frag (v2f i) : SV_Target
            {
                uint px = (uint)i.pos.x, py = (uint)i.pos.y;
                LoadPacket();
                uint M = (uint)_MaxSide, CTRL_Y = M;
                uint unitBits = (uint)_U, pay = (uint)_Pay, first = pay - HEAD;

                uint epoch = PacketBits(0, 2);
                uint storedEpoch = (uint)round(Load(0, CTRL_Y).r);
                uint nBytes = clamp((uint)_ByteCount, 1u, 16u);
                bool primary = _Primary > 0.5;
                bool consume = primary && epoch != 0 && PacketHeldSinceLastFrame(nBytes, CTRL_Y);
                bool reset = consume && epoch != storedEpoch;
                uint unitId = PacketBits(2, unitBits);
                uint storedVer = (uint)round(Load(1, CTRL_Y).r);
                uint packetVer = (consume && unitId == 0) ? PacketBits(2 + unitBits, HEAD) + 1 : 0;
                uint version = packetVer != 0 ? packetVer : (reset ? 0 : storedVer);

                // ---- control row
                if (py == CTRL_Y)
                {
                    if (px == 0) return float4(consume ? epoch : storedEpoch, 0, 0, 1);
                    if (px == 1) return float4(version, 0, 0, 1);
                    // the bytes this pass saw, for the next frame to compare against
                    if (px >= PREV_X && px < PREV_X + 4) return primary ? CurPacketTexel(px - PREV_X, nBytes) : Load(px, py);
                    return Load(px, py);
                }

                // ---- cells
                float prev = reset ? 0 : Load(px, py).r;
                if (version == 0) return float4(prev, 0, 0, 1);
                uint n = 17 + 4 * version;
                if (px >= n || py >= n || px >= M || py >= M) return float4(0, 0, 0, 1);
                if (Skipped(n, px, py)) return float4(Finder(n, px, py) ? 1 : 0, 0, 0, 1);
                if (!consume) return float4(prev, 0, 0, 1);              // 取り込まないパスと半端なパケットは無視

                uint j = py * n + px - SkippedBefore(n, px, py);
                uint id = j < first ? 0 : 1 + (j - first) / pay;
                uint off = j < first ? j : (j - first) % pay;
                if (id != unitId) return float4(prev, 0, 0, 1);          // this packet says nothing about this cell
                uint bit = PacketBits(2 + unitBits + (id == 0 ? HEAD : 0) + off, 1);
                return float4(bit, 0, 0, 1);
            }
            ENDCG
        }
    }
}
