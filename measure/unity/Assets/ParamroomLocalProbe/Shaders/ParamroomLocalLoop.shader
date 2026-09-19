// Paramroom local transport probe - the camera loop's full-viewport quads.
//   camera A (_Primary = 1): copies the other buffer; the group quads (ParamroomLocalGroup) then overwrite the chunks
//                            that arrived in this frame
//   camera B (_Primary = 0): copies A, clears the status row and updates the statistics in the control row
// Layout: see ParamroomLocalGroup.shader. Control row y = STORE_ROWS + 1, one 32-bit word per texel:
//   0 frames since reset            1 chunks present              2 chunks present and correct
//   3 group-frames taken (sum)      4 group-frames rejected (sum) 5 now (ms, _Time.y)
//   6 first chunk (ms)              7 complete (ms)               8 frames at complete
//   9 session                      10 target (chunks)            11 frames with at least one group taken
//  12 longest frame (us)           13 reset time (ms)            14 frames where every non-idle group was taken
//  15 frames with both taken and rejected groups (torn frames)
// A new session value (parameter) clears the store and the statistics.
Shader "Paramroom/LocalLoop"
{
    Properties
    {
        _Src ("Source atlas (other buffer)", 2D) = "black" {}
        _Far ("Loop camera far plane", Float) = 0.0317
        _Primary ("Camera A", Float) = 0
        _StoreRows ("Store rows", Float) = 256
        _Groups ("Groups", Float) = 16
        _Session ("Session", Float) = 0
        _Target ("Target chunks", Float) = 0
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
            float _Far, _Primary, _StoreRows, _Groups, _Session, _Target;
            static const uint CHUNKS_PER_ROW = 8;

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
            float4 Bytes(uint w) { return float4((w >> 24) & 255, (w >> 16) & 255, (w >> 8) & 255, w & 255) / 255.0; }

            float4 frag (v2f i) : SV_Target
            {
                uint x = (uint)i.pos.x, y = (uint)i.pos.y;
                uint storeRows = (uint)_StoreRows, statusY = storeRows, ctrlY = storeRows + 1;
                if (_Primary > 0.5) return _Src.Load(int3(x, y, 0));

                uint session = (uint)round(_Session);
                bool reset = session != Word(9, ctrlY);
                if (y < storeRows) return reset ? 0 : _Src.Load(int3(x, y, 0));
                if (y == statusY) return 0;
                if (y != ctrlY || x >= 16) return 0;

                uint prev = reset ? 0 : Word(x, ctrlY);
                uint now = (uint)(_Time.y * 1000);
                uint w = 0;
                if (x == 1 || x == 2 || x == 7 || x == 8)
                {
                    uint present = 0, correct = 0, cap = storeRows * CHUNKS_PER_ROW;
                    if (!reset)
                        for (uint c = 0; c < cap; c++)
                        {
                            uint m = Word((c % CHUNKS_PER_ROW) * 32, c / CHUNKS_PER_ROW);
                            present += m >> 31;
                            correct += (m >> 30) & 1;
                        }
                    uint target = (uint)round(_Target);
                    bool done = target > 0 && present >= target;
                    if (x == 1) w = present;
                    else if (x == 2) w = correct;
                    else if (x == 7) w = (prev == 0 && done) ? max(now, 1) : prev;
                    else w = (prev == 0 && done) ? Word(0, ctrlY) + 1 : prev;
                }
                else if (x == 3 || x == 4 || x == 11 || x == 14 || x == 15)
                {
                    uint taken = 0, rejected = 0;
                    for (uint g = 0; g < (uint)_Groups; g++)
                    {
                        uint s = Word(g, statusY) & 255;
                        taken += s == 1; rejected += s == 2;
                    }
                    if (x == 3) w = prev + taken;
                    else if (x == 4) w = prev + rejected;
                    else if (x == 11) w = prev + (taken > 0);
                    else if (x == 14) w = prev + (taken > 0 && rejected == 0);
                    else w = prev + (taken > 0 && rejected > 0);
                }
                else if (x == 0) w = prev + 1;
                else if (x == 5) w = now;
                else if (x == 6)
                {
                    bool any = false;
                    if (!reset)
                        for (uint c = 0; c < storeRows * CHUNKS_PER_ROW && !any; c++)
                            any = (Word((c % CHUNKS_PER_ROW) * 32, c / CHUNKS_PER_ROW) >> 31) != 0;
                    w = (prev == 0 && any) ? max(now, 1) : prev;
                }
                else if (x == 9) w = session;
                else if (x == 10) w = (uint)round(_Target);
                else if (x == 12) w = max(prev, (uint)(unity_DeltaTime.x * 1e6));
                else if (x == 13) w = reset ? now : prev;
                return Bytes(w);
            }
            ENDCG
        }
    }
}
