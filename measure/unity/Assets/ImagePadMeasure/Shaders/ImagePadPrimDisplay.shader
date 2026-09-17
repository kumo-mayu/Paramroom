// ImagePad primitive decoder - display quad. Shows the display canvas region of the decoder atlas
// (x 256..512, y 0..256 of the 512 x 288 RGBAHalf atlas, values 0..255), with the quad reshaped to the sent aspect ratio.
Shader "ImagePad/PrimDisplay"
{
    Properties
    {
        _Atlas ("Decoder atlas", 2D) = "black" {}
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
            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
            v2f vert (appdata v)
            {
                // un-stretch: the canvas holds the image stretched to a square; the accepted aspect code
                // (control texel x4, y 280; 0 = 1:1) shrinks the quad's short side, the long side keeps the quad size
                uint code = (uint)round(_Atlas.Load(int3(4, 280, 0)).r);
                float aspect = code == 0 ? 1 : pow(2, (code - 1) / 254.0 * 4 - 2);
                v.vertex.xy *= aspect >= 1 ? float2(1, 1 / aspect) : float2(aspect, 1);
                v2f o; o.pos = UnityObjectToClipPos(v.vertex); o.uv = v.uv; return o;
            }
            fixed4 frag (v2f i) : SV_Target
            {
                uint x = min(255u, (uint)(i.uv.x * 256));
                uint y = min(255u, (uint)((1 - i.uv.y) * 256)); // canvas row 0 = top
                float3 c = _Atlas.Load(int3(256 + x, y, 0)).rgb / 255.0;
                return fixed4(GammaToLinearSpace(saturate(c)), 1);
            }
            ENDCG
        }
    }
}
