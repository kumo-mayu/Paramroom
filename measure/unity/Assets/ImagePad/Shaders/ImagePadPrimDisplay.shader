// ImagePad primitive decoder - display quad. Shows the display canvas region of the decoder atlas
// (C = _Canvas: x C..2C, y 0..C, values 0..255; see ImagePadPrimDecoder.shader), with the quad reshaped to the sent
// aspect ratio.
Shader "ImagePad/PrimDisplay"
{
    Properties
    {
        _Atlas ("Decoder atlas", 2D) = "black" {}
        _Canvas ("Canvas texels (256 or 512)", Float) = 256
        _StoreTexels ("Primitive store texels (decoder)", Float) = 8192
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
            float _Canvas, _StoreTexels;
            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
            v2f vert (appdata v)
            {
                // un-stretch: the canvas holds the image stretched to a square; the accepted aspect code
                // (control texel x4; 0 = 1:1) shrinks the quad's short side, the long side keeps the quad size
                uint C = (uint)_Canvas;
                uint ctrlY = C + ((uint)_StoreTexels + 2 * C - 1) / (2 * C) + 8;
                uint code = (uint)round(_Atlas.Load(int3(4, ctrlY, 0)).r);
                float aspect = code == 0 ? 1 : pow(2, (code - 1) / 254.0 * 4 - 2);
                v.vertex.xy *= aspect >= 1 ? float2(1, 1 / aspect) : float2(aspect, 1);
                v2f o; o.pos = UnityObjectToClipPos(v.vertex); o.uv = v.uv; return o;
            }
            fixed4 frag (v2f i) : SV_Target
            {
                uint C = (uint)_Canvas;
                uint x = min(C - 1, (uint)(i.uv.x * C));
                uint y = min(C - 1, (uint)((1 - i.uv.y) * C)); // canvas row 0 = top
                float3 c = _Atlas.Load(int3(C + x, y, 0)).rgb / 255.0;
                return fixed4(GammaToLinearSpace(saturate(c)), 1);
            }
            ENDCG
        }
    }
}
