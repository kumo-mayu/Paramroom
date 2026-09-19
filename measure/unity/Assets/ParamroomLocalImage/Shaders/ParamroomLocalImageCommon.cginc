// Paramroom local image v1 - shared by the decoding passes (docs/research/13). The reference is sim/local/lpic.js:
// every function here has a counterpart there, and the Unity test compares the pictures.
//
// Store atlas (ARGB32, written by the loop): chunk c at x = (c % 8) * 32, y = c / 8, 32 texels:
//   texel 0 = marker (bit 31 = present, low 16 bits = chunk id), texel j = parameter j's 28-bit payload
//   chunk 0 = header: w1 = [width 12][height 12][version 4], w2 = [quality 7][chunks 16][0 5]
//   chunk c >= 1:     w1 = [first block 20][blocks 8], w2..w31 = the 840-bit stream
// Control row: y = STORE_ROWS + 1 (see ParamroomLocalImageLoop.shader)
#ifndef PARAMROOM_LOCAL_IMAGE_COMMON
#define PARAMROOM_LOCAL_IMAGE_COMMON
#include "ParamroomLocalImageTables.cginc"

#define STORE_ROWS 512
#define CTRL_Y (STORE_ROWS + 1)
#define CHUNKS_PER_ROW 8
#define WORD_BITS 28
#define BAND_ROWS 128   // image rows decoded per frame by the IDCT passes

Texture2D<float4> _Store;

uint StoreWord(uint x, uint y)
{
    float4 t = round(_Store.Load(int3(x, y, 0)) * 255.0);
    return ((uint)t.r << 24) | ((uint)t.g << 16) | ((uint)t.b << 8) | (uint)t.a;
}
uint ChunkWord(uint c, uint j) { return StoreWord((c % CHUNKS_PER_ROW) * 32 + j, c / CHUNKS_PER_ROW); }
uint Ctrl(uint x) { return StoreWord(x, CTRL_Y); }

// header
uint ImageW() { return ChunkWord(0, 1) >> 16; }
uint ImageH() { return (ChunkWord(0, 1) >> 4) & 0xFFF; }
uint Quality() { return ChunkWord(0, 2) >> 21; }
uint ChunkCount() { return (ChunkWord(0, 2) >> 5) & 0xFFFF; }
uint FirstBlock(uint c) { return ChunkWord(c, 1) >> 8; }
uint BlockCount(uint c) { return ChunkWord(c, 1) & 255; }

// n (<= 16) bits of chunk c's stream at bit p (bits past the end read as 0)
uint Peek(uint c, uint p, uint n)
{
    uint w = p / WORD_BITS, o = p % WORD_BITS;
    uint a = w < 30 ? ChunkWord(c, 2 + w) : 0;
    uint b = w + 1 < 30 ? ChunkWord(c, 3 + w) : 0;
    // 56 bits a:b, take n from offset o
    uint avail = WORD_BITS - o;
    uint v;
    if (n <= avail) v = (a >> (avail - n)) & ((1u << n) - 1);
    else v = ((a & ((1u << avail) - 1)) << (n - avail)) | (b >> (WORD_BITS - (n - avail)));
    return v;
}

// Huffman decode at p with table t (0 DC Y, 1 DC C, 2 AC Y, 3 AC C): symbol, and the code length in len
uint Huff(uint c, uint p, uint t, out uint len)
{
    uint code16 = Peek(c, p, 16);
    for (uint l = 1; l <= 16; l++)
    {
        int code = (int)(code16 >> (16 - l));
        if (HUFF_MAXCODE[t][l] >= 0 && code <= HUFF_MAXCODE[t][l])
        {
            len = l;
            return HUFF_VALS[t][HUFF_VALPTR[t][l] + code - HUFF_MINCODE[t][l]];
        }
    }
    len = 16;
    return 0;
}
int Extend(uint v, uint s) { return s == 0 ? 0 : (v < (1u << (s - 1)) ? (int)v - (int)(1u << s) + 1 : (int)v); }

// skip one block at p (comp type t: 0 luma, 1 chroma); returns the DC difference, advances p
int SkipBlock(uint c, inout uint p, uint t)
{
    uint len;
    uint s = Huff(c, p, t, len); p += len;
    int dcDiff = Extend(Peek(c, p, s), s); p += s;
    for (uint k = 1; k < 64;)
    {
        uint a = Huff(c, p, 2 + t, len); p += len;
        uint r = a >> 4, sz = a & 15;
        if (sz == 0) { if (r == 15) { k += 16; continue; } break; }
        p += sz; k += r + 1;
    }
    return dcDiff;
}

// quantisation step of raster coefficient z for comp type t (libjpeg integer scaling of the base table)
uint QStep(uint t, uint z, uint quality)
{
    uint s = quality < 50 ? 5000 / quality : 200 - 2 * quality;
    return clamp((QBASE[t][z] * s + 50) / 100, 1, 255);
}

// Which decode pass runs this frame: -1 none, 0 block map, b + 1 = IDCT band b. After the store completes, the whole
// sequence (block map, then one band of BAND_ROWS image rows per frame) runs twice, then everything idles (the passes
// cull their quad in the vertex shader and the render textures keep the picture).
int DecodePhase()
{
    uint cf = Ctrl(8);
    if (cf == 0) return -1;
    uint k = Ctrl(0) - cf;
    uint bands = (ImageH() + BAND_ROWS - 1) / BAND_ROWS;
    if (k < 1 || k > 2 * (bands + 1)) return -1;
    return (int)((k - 1) % (bands + 1));
}

float4 WordToColor(uint w) { return float4((w >> 24) & 255, (w >> 16) & 255, (w >> 8) & 255, w & 255) / 255.0; }
#endif
