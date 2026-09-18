// Paramroom measurement board.
// Displays the synced packet received through material properties _P0.._P31 (each = one Int parameter 0..255,
// delivered by an FX Direct blend tree) as a black/white cell grid that a video decoder can read.
//
// Packet layout (bytes):
//   0-1  sequence number (big endian)
//   2    mode (0 = hash payload, 1 = sweep payload)
//   3    epoch / flags (sender always sends non-zero)
//   4..N-1 payload: expected byte j = f(mode, seq, j)  (see ExpectedByte, identical in the OSC sender)
//
// Board: magenta frame (for detection, cyan segment at the top-left corner marks orientation) around a 8 x 12 grid of cells, white = 1, black = 0.
//   row 0-1 : seq bits 15..0
//   row 2   : mode bits 7..0
//   row 3   : [consistent] [exact] [IsLocal] [IsOnFriendsList] [epoch!=0] [allZero] [bundleMark] [always 1]
//   row 4-7 : payload mismatch map, bytes 4..31 (1 = mismatch), last 4 cells = 0
//   row 8-10: camera loop counter bits 23..0 (read from _LoopTex; 0 when the loop is not running)
//   row 11  : epoch byte bits 7..0
Shader "Paramroom/MeasureBoard"
{
    Properties
    {
        _ByteCount ("Byte Count", Float) = 32
        _LoopTex ("Loop RenderTexture", 2D) = "black" {}
        _IsLocal ("IsLocal", Float) = 0
        _IsOnFriendsList ("IsOnFriendsList", Float) = 0
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
        Cull Off
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 4.5
            #include "UnityCG.cginc"

            float _ByteCount;
            float _IsLocal, _IsOnFriendsList;
            Texture2D<float4> _LoopTex;
            float _P0, _P1, _P2, _P3, _P4, _P5, _P6, _P7, _P8, _P9, _P10, _P11, _P12, _P13, _P14, _P15;
            float _P16, _P17, _P18, _P19, _P20, _P21, _P22, _P23, _P24, _P25, _P26, _P27, _P28, _P29, _P30, _P31;

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

            v2f vert (appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                return o;
            }

            float RawByte(uint i)
            {
                float p[32] = { _P0, _P1, _P2, _P3, _P4, _P5, _P6, _P7, _P8, _P9, _P10, _P11, _P12, _P13, _P14, _P15,
                                _P16, _P17, _P18, _P19, _P20, _P21, _P22, _P23, _P24, _P25, _P26, _P27, _P28, _P29, _P30, _P31 };
                return p[i];
            }

            // Must match measure/osc/packet.js expectedByte()
            uint ExpectedByte(uint mode, uint seq, uint j)
            {
                if (mode == 1) return (seq + j * 37u) & 255u;
                uint h = seq * 2654435761u ^ (j * 2246822519u);
                h ^= h >> 15; h *= 739982445u; h ^= h >> 12; h *= 695872825u; h ^= h >> 15;
                return h & 255u;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                const float frameW = 0.04;
                float2 uv = i.uv;
                if (uv.x < frameW || uv.x > 1 - frameW || uv.y < frameW || uv.y > 1 - frameW)
                    return (uv.x < 0.2 && uv.y > 0.8) ? fixed4(0, 1, 1, 1) : fixed4(1, 0, 1, 1); // cyan = top-left (orientation mark)
                float2 g = (uv - frameW) / (1 - 2 * frameW);
                uint col = min(7u, (uint)floor(g.x * 8));
                uint row = min(11u, (uint)floor((1 - g.y) * 12));
                // small gap between cells (grey) for robust sampling
                float2 cellUV = frac(float2(g.x * 8, (1 - g.y) * 12));
                if (any(cellUV < 0.08) || any(cellUV > 0.92)) return fixed4(0.5, 0.5, 0.5, 1);

                uint n = (uint)round(clamp(_ByteCount, 4, 32));
                uint b[32];
                float maxErr = 0;
                bool allZero = true;
                for (uint k = 0; k < 32; k++)
                {
                    float raw = RawByte(k);
                    uint v = (uint)clamp(round(raw), 0, 255);
                    b[k] = v;
                    if (k < n)
                    {
                        maxErr = max(maxErr, abs(raw - round(raw)));
                        if (v != 0) allZero = false;
                    }
                }
                uint seq = (b[0] << 8) | b[1];
                uint mode = b[2];
                uint epoch = b[3];
                bool consistent = true;
                uint mismatch[32];
                for (uint j = 0; j < 32; j++)
                {
                    mismatch[j] = 0;
                    if (j >= 4 && j < n && b[j] != ExpectedByte(mode, seq, j)) { mismatch[j] = 1; consistent = false; }
                }

                uint bit = 0;
                if (row <= 1) bit = (seq >> (15 - (row * 8 + col))) & 1u;
                else if (row == 2) bit = (mode >> (7 - col)) & 1u;
                else if (row == 3)
                {
                    uint flags[8] = { consistent ? 1u : 0u, maxErr < 0.001 ? 1u : 0u, _IsLocal > 0.5 ? 1u : 0u, _IsOnFriendsList > 0.5 ? 1u : 0u,
                                      epoch != 0 ? 1u : 0u, allZero ? 1u : 0u, 0u, 1u };
                    bit = flags[col];
                }
                else if (row <= 7)
                {
                    uint idx = 4 + (row - 4) * 8 + col;
                    bit = idx < 32 ? mismatch[idx] : 0u;
                }
                else if (row <= 10)
                {
                    float4 t = _LoopTex.Load(int3(0, 0, 0));
                    uint cnt = (uint)round(t.r * 255) | ((uint)round(t.g * 255) << 8) | ((uint)round(t.b * 255) << 16);
                    bit = (cnt >> (23 - ((row - 8) * 8 + col))) & 1u;
                }
                else bit = (epoch >> (7 - col)) & 1u;
                return bit ? fixed4(1, 1, 1, 1) : fixed4(0, 0, 0, 1);
            }
            ENDCG
        }
    }
}
