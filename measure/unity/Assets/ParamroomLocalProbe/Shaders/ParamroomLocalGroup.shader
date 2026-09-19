// Paramroom local transport probe - one group of 32 Float parameters (camera A of the loop only).
//
// Local (not synced) Float parameters written by OSC keep their 32-bit value, and a Direct blend tree carries any bit
// pattern into a material float exactly (Unity batchmode, 2026-09-19). So one parameter carries 30 bits:
//   float bits u = 2^23 + v, v < 2^30   (exponent 1..128: no zero, denormal, NaN or Inf ever travels)
//   v = [tag 2][payload 28]
// A group is 32 parameters F0..F31:
//   F0  = header   payload = [reserved 12 = 0][chunk id 16]
//   F1..F31 = data payload = 28 bits each      -> one chunk = 31 x 28 = 868 bits
// tag = the sender's send counter mod 4. VRChat can apply a bundle across frames, so a frame may show some parameters
// of send k and the rest of send k-1; such a group has mixed tags and is ignored (the chunk comes again later).
// Groups are independent: each has its own header, so a torn frame only loses the groups it touched.
//
// Atlas (ARGB32, 4 bytes per texel, the loop shader copies it every frame):
//   store  rows 0..STORE_ROWS-1: chunk c at x = (c % 8) * 32, y = c / 8; texel 0 = marker, texels 1..31 = data
//          marker = 0x80000000 | correct << 30 | chunk     (correct: data equals the probe test pattern)
//   status row y = STORE_ROWS: texel g = this frame's state of group g (0 idle, 1 taken, 2 rejected) | tag << 8
// The mesh has two quads: quad 0 is moved onto the chunk's 32 texels (or collapsed when the group is rejected),
// quad 1 covers the group's status texel.
Shader "Paramroom/LocalGroup"
{
    Properties
    {
        _Far ("Loop camera far plane", Float) = 0.0317
        _Group ("Group index", Float) = 0
        _AtlasW ("Atlas width", Float) = 256
        _AtlasH ("Atlas height", Float) = 260
        _StoreRows ("Store rows", Float) = 256
        _F0 ("F0", Float) = 0
        _F1 ("F1", Float) = 0
        _F2 ("F2", Float) = 0
        _F3 ("F3", Float) = 0
        _F4 ("F4", Float) = 0
        _F5 ("F5", Float) = 0
        _F6 ("F6", Float) = 0
        _F7 ("F7", Float) = 0
        _F8 ("F8", Float) = 0
        _F9 ("F9", Float) = 0
        _F10 ("F10", Float) = 0
        _F11 ("F11", Float) = 0
        _F12 ("F12", Float) = 0
        _F13 ("F13", Float) = 0
        _F14 ("F14", Float) = 0
        _F15 ("F15", Float) = 0
        _F16 ("F16", Float) = 0
        _F17 ("F17", Float) = 0
        _F18 ("F18", Float) = 0
        _F19 ("F19", Float) = 0
        _F20 ("F20", Float) = 0
        _F21 ("F21", Float) = 0
        _F22 ("F22", Float) = 0
        _F23 ("F23", Float) = 0
        _F24 ("F24", Float) = 0
        _F25 ("F25", Float) = 0
        _F26 ("F26", Float) = 0
        _F27 ("F27", Float) = 0
        _F28 ("F28", Float) = 0
        _F29 ("F29", Float) = 0
        _F30 ("F30", Float) = 0
        _F31 ("F31", Float) = 0
    }
    SubShader
    {
        // after the loop's copy quad (Geometry = 2000), so this overwrites the copied texels
        Tags { "RenderType"="Opaque" "Queue"="Geometry+10" "VRCFallback"="Hidden" }
        Cull Off ZWrite Off ZTest Always
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 5.0
            #include "UnityCG.cginc"

            float _Far, _Group, _AtlasW, _AtlasH, _StoreRows;
            float _F0, _F1, _F2, _F3, _F4, _F5, _F6, _F7, _F8, _F9, _F10, _F11, _F12, _F13, _F14, _F15;
            float _F16, _F17, _F18, _F19, _F20, _F21, _F22, _F23, _F24, _F25, _F26, _F27, _F28, _F29, _F30, _F31;

            static const uint CHUNKS_PER_ROW = 8;

            uint Raw(uint i)
            {
                float f[32] = { _F0, _F1, _F2, _F3, _F4, _F5, _F6, _F7, _F8, _F9, _F10, _F11, _F12, _F13, _F14, _F15,
                                _F16, _F17, _F18, _F19, _F20, _F21, _F22, _F23, _F24, _F25, _F26, _F27, _F28, _F29, _F30, _F31 };
                return asuint(f[i]);
            }
            bool InRange(uint u) { return u >= 0x00800000u && u < 0x40800000u; }
            uint Val(uint u) { return u - 0x00800000u; }

            // the probe's test pattern (sender: measure/osc/local-probe.js uses the same hash)
            uint Hash(uint x)
            {
                x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
                return x;
            }

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f
            {
                float4 pos : SV_POSITION;
                nointerpolation uint4 info : TEXCOORD0; // quad, x0 (chunk start texel), status word, marker
            };

            // texel rectangle [x0, x1) x [y0, y1) -> clip position of corner c (0/1 per axis). Texel y counts from the top
            // of the render target, as SV_Position does in the loop shader.
            float4 Rect(float2 c, float x0, float x1, float y0, float y1)
            {
                float x = lerp(x0, x1, c.x), y = lerp(y0, y1, c.y);
                return float4(x / _AtlasW * 2 - 1, 1 - y / _AtlasH * 2, 0.5, 1);
            }

            v2f vert (appdata v)
            {
                v2f o;
                o.info = 0;
                // only loop camera A (unique far plane) draws this
                if (abs(_ProjectionParams.z - _Far) > 0.0005) { o.pos = float4(0, 0, -10, 1); return o; }
                uint quad = v.uv.y > 1.5 ? 1 : 0;
                float2 corner = float2(v.uv.x, v.uv.y - 2 * quad);

                uint u0 = Raw(0);
                bool idle = true, ok = true, correct = true;
                uint tag = Val(u0) >> 28;
                uint chunk = Val(u0) & 0xFFFF;
                if (u0 != 0) idle = false;
                if (!InRange(u0) || (Val(u0) & 0x0FFF0000u) != 0) ok = false;
                for (uint i = 1; i < 32; i++)
                {
                    uint u = Raw(i);
                    if (u != 0) idle = false;
                    if (!InRange(u) || (Val(u) >> 28) != tag) ok = false;
                    if ((Val(u) & 0x0FFFFFFFu) != (Hash(chunk * 32 + i) & 0x0FFFFFFFu)) correct = false;
                }
                if (chunk >= (uint)_StoreRows * CHUNKS_PER_ROW) ok = false;
                uint status = idle ? 0 : (ok ? 1 : 2);

                if (quad == 0)
                {
                    if (!ok) { o.pos = float4(0, 0, -10, 1); return o; }
                    float x0 = (chunk % CHUNKS_PER_ROW) * 32, y0 = chunk / CHUNKS_PER_ROW;
                    o.pos = Rect(corner, x0, x0 + 32, y0, y0 + 1);
                    o.info = uint4(0, (uint)x0, 0, 0x80000000u | (correct ? 0x40000000u : 0) | chunk);
                }
                else
                {
                    float g = _Group;
                    o.pos = Rect(corner, g, g + 1, _StoreRows, _StoreRows + 1);
                    o.info = uint4(1, 0, status | (tag << 8), 0);
                }
                return o;
            }

            float4 Bytes(uint w) { return float4((w >> 24) & 255, (w >> 16) & 255, (w >> 8) & 255, w & 255) / 255.0; }

            float4 frag (v2f i) : SV_Target
            {
                if (i.info.x == 1) return Bytes(i.info.z);
                uint j = (uint)i.pos.x - i.info.y;
                if (j == 0) return Bytes(i.info.w);
                return Bytes(Val(Raw(min(j, 31))) & 0x0FFFFFFFu);
            }
            ENDCG
        }
    }
}
