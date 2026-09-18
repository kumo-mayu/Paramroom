// Paramroom camera-loop counter (double-buffered).
// Camera A renders quad A (this shader, _Src = RT B) into RT A; camera B renders quad B (_Src = RT A) into RT B.
// Each pass outputs (counter read from the other RT) + 1, 24-bit little endian in RGB of an RGBA8 linear RT.
// The quad is only drawn by its loop camera: the camera's far plane is set to the unique value _Far,
// every other camera (players, mirrors, VRChat photo camera) discards it.
Shader "Paramroom/LoopCounter"
{
    Properties
    {
        _Src ("Source RenderTexture", 2D) = "black" {}
        _Far ("Loop camera far plane", Float) = 0.0217
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
            #pragma target 4.5
            #include "UnityCG.cginc"

            Texture2D<float4> _Src;
            float _Far;

            struct appdata { float4 vertex : POSITION; };
            struct v2f { float4 pos : SV_POSITION; };

            v2f vert (appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                if (abs(_ProjectionParams.z - _Far) > 0.0005) o.pos = float4(0, 0, -10, 1); // cull for other cameras
                return o;
            }

            float4 frag (v2f i) : SV_Target
            {
                float4 t = _Src.Load(int3(0, 0, 0));
                uint cnt = (uint)round(t.r * 255) | ((uint)round(t.g * 255) << 8) | ((uint)round(t.b * 255) << 16);
                cnt = (cnt + 1u) & 0xFFFFFFu;
                return float4((cnt & 255u) / 255.0, ((cnt >> 8) & 255u) / 255.0, ((cnt >> 16) & 255u) / 255.0, 1);
            }
            ENDCG
        }
    }
}
