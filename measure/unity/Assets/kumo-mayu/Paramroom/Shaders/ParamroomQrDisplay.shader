// Paramroom QR-only decoder - display quad. Shows the cell grid of the QR decoder atlas
// (see ParamroomQrDecoder.shader) with a quiet zone around it, which QR readers need.
// The quad stays square: a QR code is always 1:1, so there is no aspect code to read.
Shader "Paramroom/QrDisplay"
{
    Properties
    {
        _Atlas ("QR decoder atlas", 2D) = "black" {}
        _MaxSide ("Largest QR side (17 + 4 * version)", Float) = 57
        _Quiet ("Quiet zone (cells)", Float) = 4
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
            Texture2D<float4> _Atlas;
            float _MaxSide, _Quiet;
            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
            v2f vert (appdata v) { v2f o; o.pos = UnityObjectToClipPos(v.vertex); o.uv = v.uv; return o; }
            fixed4 frag (v2f i) : SV_Target
            {
                uint M = (uint)_MaxSide, quiet = (uint)_Quiet;
                uint version = (uint)round(_Atlas.Load(int3(1, M, 0)).r);
                if (version == 0) return fixed4(GammaToLinearSpace(float3(1, 1, 1)), 1);   // nothing received yet
                uint n = 17 + 4 * version, side = n + 2 * quiet;
                int x = (int)(i.uv.x * side) - (int)quiet;
                int y = (int)((1 - i.uv.y) * side) - (int)quiet;                           // row 0 = top
                float c = 1;
                if (x >= 0 && y >= 0 && x < (int)n && y < (int)n) c = 1 - _Atlas.Load(int3(x, y, 0)).r;
                return fixed4(GammaToLinearSpace(saturate(float3(c, c, c))), 1);
            }
            ENDCG
        }
    }
}
