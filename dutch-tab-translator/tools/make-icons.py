"""Generate simple PNG icons (no dependencies). Run: python3 tools/make-icons.py"""
import struct, zlib, pathlib

def png(size):
    bg, fg = (37, 99, 235), (255, 255, 255)
    rows = []
    r = size * 0.22  # corner radius
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            cx = min(max(x + .5, r), size - r); cy = min(max(y + .5, r), size - r)
            inside = (x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= r * r
            # two "sound wave" bars: short left (source), tall right (translation)
            u, v = (x + .5) / size, (y + .5) / size
            bar = (0.22 < u < 0.38 and 0.38 < v < 0.62) or (0.50 < u < 0.64 and 0.24 < v < 0.76) or (0.72 < u < 0.82 and 0.34 < v < 0.66)
            c = fg if bar else bg
            row += bytes([*c, 255 if inside else 0])
        rows.append(bytes(row))
    raw = b"".join(rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

out = pathlib.Path(__file__).resolve().parent.parent / "icons"
for s in (16, 32, 48, 128):
    (out / f"icon{s}.png").write_bytes(png(s))
