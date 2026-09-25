"""Draws the app icons (the favicon's tempo zig-zag) as PNGs. Standard library only.

    python tools/make-icons.py      -> icons/*.png
"""
import math
import struct
import zlib
from pathlib import Path

BG = (0x1A, 0x1A, 0x19)
LINE = (0x39, 0x87, 0xE5)
# polyline in the favicon's 32x32 viewBox
PATH = [(5, 21), (10, 14), (15, 18), (20, 10), (27, 13)]
OUT = Path(__file__).resolve().parent.parent / "icons"


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def render(size, *, glyph_scale=1.0, radius=7 / 32, full_bleed=False, ss=4):
    """RGBA rows. glyph_scale < 1 shrinks the zig-zag towards the centre (maskable safe zone)."""
    rows = []
    unit = size / 32
    stroke = 3 * unit * glyph_scale / 2
    pts = [((16 + (x - 16) * glyph_scale) * unit, (16 + (y - 16) * glyph_scale) * unit) for x, y in PATH]
    r = radius * size
    for j in range(size):
        row = bytearray()
        for i in range(size):
            cov_bg = cov_line = 0.0
            for sj in range(ss):
                for si in range(ss):
                    x, y = i + (si + 0.5) / ss, j + (sj + 0.5) / ss
                    inside = True
                    if not full_bleed:
                        cx = min(max(x, r), size - r)
                        cy = min(max(y, r), size - r)
                        inside = math.hypot(x - cx, y - cy) <= r
                    if not inside:
                        continue
                    cov_bg += 1
                    d = min(seg_dist(x, y, *pts[k], *pts[k + 1]) for k in range(len(pts) - 1))
                    if d <= stroke:
                        cov_line += 1
            n = ss * ss
            a, l = cov_bg / n, (cov_line / cov_bg if cov_bg else 0)
            rgb = [round(BG[c] * (1 - l) + LINE[c] * l) for c in range(3)]
            row += bytes(rgb + [round(255 * a)])
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b"".join(b"\x00" + r for r in rows)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for name, size, kw in [
        ("icon-192.png", 192, {}),
        ("icon-512.png", 512, {}),
        ("icon-maskable-512.png", 512, {"full_bleed": True, "glyph_scale": 0.72, "radius": 0}),
        ("apple-touch-icon.png", 180, {"full_bleed": True, "glyph_scale": 0.85, "radius": 0}),
    ]:
        write_png(OUT / name, render(size, ss=3, **kw), size)
        print("wrote", OUT / name)
