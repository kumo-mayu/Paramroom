// Paramroom local image - the store loop's full-viewport quads (docs/research/13).
//   camera A (_Primary = 1): copies the other buffer; the group quads then overwrite the chunks that arrived this frame
//   camera B (_Primary = 0): copies A, clears the status row, updates the control row
// Store layout: ParamroomLocalImageCommon.cginc. Control row (one word per texel):
//   0 frames since reset        1 chunks present            2 chunks in the image (header), 0 = no header yet
//   3 group-frames taken        4 group-frames rejected     5 now (ms)
//   6 first chunk (ms)          7 complete (ms)             8 frame count at completion (0 = not complete)
//   9 session                  10 width << 16 | height      11 decoded (ms): the decode passes have run once
//  12 longest frame (us)       13 reset (ms)               14 frames where every non-idle group was taken
//  15 frames with both taken and rejected groups
// Decoding: after completion the decode passes run on frames k = frames - completeFrame = 1 .. 2 * (bands + 1),
// phase (k - 1) % (bands + 1): 0 = block map, p >= 1 = IDCT band p - 1 (ParamroomLocalImageCommon.cginc DecodePhase).
Shader "Paramroom/LocalImageLoop"
{
    Properties
    {
        _Src ("Source atlas (other buffer)", 2D) = "black" {}
        _Far ("Loop camera far plane", Float) = 0.0417
        _Primary ("Camera A", Float) = 0
        _Groups ("Groups", Float) = 16
        _Session ("Session", Float) = 0
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
            float _Far, _Primary, _Groups, _Session;

            #define STORE_ROWS 512
            #define CTRL_Y (STORE_ROWS + 1)
            #define CHUNKS_PER_ROW 8

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; };

            v2f vert (appdata v)
            {
                v2f o;
                if (abs(_ProjectionParams.z - _Far) > 0.0005) { o.pos = float4(0, 0, -10, 1); return o; }
                float2 p = v.uv * 2 - 1;
                o.pos = float4(p.x, p.y * _ProjectionParams.x, 0.5, 1);
                return o;
            }

            uint Word(uint x, uint y)
            {
                float4 t = round(_Src.Load(int3(x, y, 0)) * 255.0);
                return ((uint)t.r << 24) | ((uint)t.g << 16) | ((uint)t.b << 8) | (uint)t.a;
            }
            uint ChunkWord(uint c, uint j) { return Word((c % CHUNKS_PER_ROW) * 32 + j, c / CHUNKS_PER_ROW); }
            float4 Bytes(uint w) { return float4((w >> 24) & 255, (w >> 16) & 255, (w >> 8) & 255, w & 255) / 255.0; }

            float4 frag (v2f i) : SV_Target
            {
                uint x = (uint)i.pos.x, y = (uint)i.pos.y;
                if (_Primary > 0.5) return _Src.Load(int3(x, y, 0));

                uint session = (uint)round(_Session);
                bool reset = session != Word(9, CTRL_Y);
                if (y < STORE_ROWS) return reset ? 0 : _Src.Load(int3(x, y, 0));
                if (y != CTRL_Y || x >= 16) return 0;   // status row (per frame) and the rest

                uint prev = reset ? 0 : Word(x, CTRL_Y);
                uint now = (uint)(_Time.y * 1000);
                bool header = !reset && (ChunkWord(0, 0) >> 31) != 0;
                uint total = header ? (ChunkWord(0, 2) >> 5) & 0xFFFF : 0;
                uint w = 0;
                if (x == 1 || x == 7 || x == 8 || x == 6)
                {
                    uint present = 0;
                    if (!reset)
                        for (uint c = 0; c < STORE_ROWS * CHUNKS_PER_ROW; c++)
                            present += ChunkWord(c, 0) >> 31;
                    bool done = total > 0 && present >= total;
                    uint frames = reset ? 0 : Word(0, CTRL_Y) + 1;
                    if (x == 1) w = present;
                    else if (x == 6) w = (prev == 0 && present > 0) ? max(now, 1) : prev;
                    else if (x == 7) w = (prev == 0 && done) ? max(now, 1) : prev;
                    else w = (prev == 0 && done) ? frames : prev;
                }
                else if (x == 3 || x == 4 || x == 14 || x == 15)
                {
                    uint taken = 0, rejected = 0;
                    for (uint g = 0; g < (uint)_Groups; g++)
                    {
                        uint s = Word(g, STORE_ROWS) & 255;
                        taken += s == 1; rejected += s == 2;
                    }
                    if (x == 3) w = prev + taken;
                    else if (x == 4) w = prev + rejected;
                    else if (x == 14) w = prev + (taken > 0 && rejected == 0);
                    else w = prev + (taken > 0 && rejected > 0);
                }
                else if (x == 0) w = prev + 1;
                else if (x == 2) w = total;
                else if (x == 5) w = now;
                else if (x == 9) w = session;
                else if (x == 10) w = header ? ((ChunkWord(0, 1) >> 16) << 16) | ((ChunkWord(0, 1) >> 4) & 0xFFF) : 0;
                else if (x == 11)
                {
                    // one frame after the last band of the first decode sequence
                    uint cf = reset ? 0 : Word(8, CTRL_Y), frames = reset ? 0 : Word(0, CTRL_Y) + 1;
                    uint h = header ? (ChunkWord(0, 1) >> 4) & 0xFFF : 0;
                    uint bands = (h + 127) / 128;
                    w = (prev == 0 && cf > 0 && frames - cf == bands + 2) ? max(now, 1) : prev;
                }
                else if (x == 12) w = max(prev, (uint)(unity_DeltaTime.x * 1e6));
                else if (x == 13) w = reset ? now : prev;
                return Bytes(w);
            }
            ENDCG
        }
    }
}
