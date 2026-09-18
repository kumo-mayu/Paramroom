// Minimal PNG writer (8-bit RGB, no interlacing), used by the command line tool to dump a canvas.
//
// This exists so the project does not depend on a package for it: StbImageWriteSharp, which it used before, ships with
// no licence at all (neither on NuGet nor in its repository), which makes it unsafe to redistribute.
//
// The format is small enough to write directly: a signature, an IHDR, one IDAT holding a zlib stream, and an IEND.
// The zlib stream uses deflate's "stored" blocks (no compression), so the only compression code needed is the Adler-32
// and CRC-32 checksums. Files come out about as large as the raw pixels, which is fine for a debugging dump.
using System.Buffers.Binary;
using System.IO.Compression;

namespace Paramroom;

public static class PngWriter
{
    public static void WriteRgb(Stream s, byte[] rgb, int w, int h)
    {
        if (rgb.Length < w * h * 3) throw new ArgumentException("rgb is shorter than w * h * 3");
        s.Write(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A });

        var ihdr = new byte[13];
        BinaryPrimitives.WriteInt32BigEndian(ihdr.AsSpan(0), w);
        BinaryPrimitives.WriteInt32BigEndian(ihdr.AsSpan(4), h);
        ihdr[8] = 8;    // bit depth
        ihdr[9] = 2;    // colour type: truecolour (RGB)
        Chunk(s, "IHDR", ihdr);

        // scanlines, each prefixed with filter type 0 (none)
        var raw = new byte[h * (1 + w * 3)];
        for (int y = 0, o = 0; y < h; y++)
        {
            raw[o++] = 0;
            Array.Copy(rgb, y * w * 3, raw, o, w * 3);
            o += w * 3;
        }
        Chunk(s, "IDAT", Zlib(raw));
        Chunk(s, "IEND", Array.Empty<byte>());
    }

    public static void WriteRgb(string path, byte[] rgb, int w, int h)
    {
        using var f = File.Create(path);
        WriteRgb(f, rgb, w, h);
    }

    static void Chunk(Stream s, string type, byte[] data)
    {
        var len = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(len, data.Length);
        s.Write(len);
        var body = new byte[4 + data.Length];
        for (int i = 0; i < 4; i++) body[i] = (byte)type[i];
        data.CopyTo(body, 4);
        s.Write(body);
        var crc = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(crc, Crc32(body));
        s.Write(crc);
    }

    // zlib container around a deflate stream
    static byte[] Zlib(byte[] data)
    {
        using var ms = new MemoryStream();
        ms.WriteByte(0x78); ms.WriteByte(0x01);   // deflate, 32K window, no preset dictionary
        using (var z = new DeflateStream(ms, CompressionLevel.Fastest, leaveOpen: true)) z.Write(data);
        var adler = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(adler, Adler32(data));
        ms.Write(adler);
        return ms.ToArray();
    }

    static uint Adler32(byte[] d)
    {
        uint a = 1, b = 0;
        foreach (var x in d) { a = (a + x) % 65521; b = (b + a) % 65521; }
        return (b << 16) | a;
    }

    static readonly uint[] CrcTable = BuildCrcTable();
    static uint[] BuildCrcTable()
    {
        var t = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            uint c = n;
            for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
            t[n] = c;
        }
        return t;
    }

    static uint Crc32(byte[] d)
    {
        uint c = 0xFFFFFFFF;
        foreach (var x in d) c = CrcTable[(c ^ x) & 0xFF] ^ (c >> 8);
        return c ^ 0xFFFFFFFF;
    }
}
