"""Draws the app icon as PNGs and an SVG favicon. Standard library only.

A metronome with its needle tilted off-centre: the app's whole premise is
"is the needle drifting", so the icon draws that directly instead of an
abstract shape. Both the SVG and the PNGs are rendered from the same 32x32
coordinates, so they match.

    python tools/make-icons.py      -> icons/*.png, icons/icon.svg
"""
import math
import struct
import zlib
from pathlib import Path

BG = (0x14, 0x14, 0x13)      # icon background (near-black, like the app page)
FRAME = (0xEC, 0xEA, 0xE3)   # metronome body (off-white)
NEEDLE = (0x4A, 0x9B, 0xF0)  # the tempo needle: the app's accent blue

# 32x32 viewBox, shared by the SVG and the raster renderer below.
BODY = [(13, 8), (19, 8), (23, 27), (9, 27), (13, 8)]  # closed outline
BASE = [(7, 27.5), (25, 27.5)]
PIVOT = (16, 8)
PIVOT_R = 1.6
NEEDLE_LINE = [(16, 10.2), (21, 24)]  # tilted off-centre: the drift
WEIGHT = (19.3, 18.8)
WEIGHT_R = 1.9
STROKE_W = 1.7

OUT = Path(__file__).resolve().parent.parent / "icons"


def hexcolor(c):
    return "#%02x%02x%02x" % c


def write_svg(path, radius=7):
    p = " ".join(f"L{x},{y}" if i else f"M{x},{y}" for i, (x, y) in enumerate(BODY))
    path.write_text(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="{radius}" fill="{hexcolor(BG)}"/>
  <path d="{p}" fill="none" stroke="{hexcolor(FRAME)}" stroke-width="{STROKE_W}" stroke-linejoin="round"/>
  <line x1="{BASE[0][0]}" y1="{BASE[0][1]}" x2="{BASE[1][0]}" y2="{BASE[1][1]}" stroke="{hexcolor(FRAME)}" stroke-width="{STROKE_W}" stroke-linecap="round"/>
  <circle cx="{PIVOT[0]}" cy="{PIVOT[1]}" r="{PIVOT_R}" fill="{hexcolor(FRAME)}"/>
  <line x1="{NEEDLE_LINE[0][0]}" y1="{NEEDLE_LINE[0][1]}" x2="{NEEDLE_LINE[1][0]}" y2="{NEEDLE_LINE[1][1]}" stroke="{hexcolor(NEEDLE)}" stroke-width="{STROKE_W}" stroke-linecap="round"/>
  <circle cx="{WEIGHT[0]}" cy="{WEIGHT[1]}" r="{WEIGHT_R}" fill="{hexcolor(NEEDLE)}"/>
</svg>
''', encoding="utf-8")


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def polyline_dist(px, py, pts):
    return min(seg_dist(px, py, *pts[i], *pts[i + 1]) for i in range(len(pts) - 1))


def render(size, *, glyph_scale=1.0, radius=7 / 32, full_bleed=False, ss=4):
    """RGBA rows. glyph_scale < 1 shrinks the metronome towards the centre (maskable safe zone)."""
    unit = size / 32
    stroke = STROKE_W * unit * glyph_scale / 2
    cx = cy = 16 * unit

    def pt(x, y):
        return (cx + (x - 16) * unit * glyph_scale, cy + (y - 16) * unit * glyph_scale)

    body, base, needle = [pt(*p) for p in BODY], [pt(*p) for p in BASE], [pt(*p) for p in NEEDLE_LINE]
    pivot, weight = pt(*PIVOT), pt(*WEIGHT)
    pivot_r, weight_r = PIVOT_R * unit * glyph_scale, WEIGHT_R * unit * glyph_scale
    r = radius * size

    rows = []
    for j in range(size):
        row = bytearray()
        for i in range(size):
            cov_bg = cov_frame = cov_needle = 0.0
            for sj in range(ss):
                for si in range(ss):
                    x, y = i + (si + 0.5) / ss, j + (sj + 0.5) / ss
                    if not full_bleed:
                        cxg, cyg = min(max(x, r), size - r), min(max(y, r), size - r)
                        if math.hypot(x - cxg, y - cyg) > r:
                            continue
                    cov_bg += 1
                    if (polyline_dist(x, y, body) <= stroke or polyline_dist(x, y, base) <= stroke
                            or math.hypot(x - pivot[0], y - pivot[1]) <= pivot_r):
                        cov_frame += 1
                    elif polyline_dist(x, y, needle) <= stroke or math.hypot(x - weight[0], y - weight[1]) <= weight_r:
                        cov_needle += 1
            n = ss * ss
            a = cov_bg / n
            lf, ln = (cov_frame / cov_bg, cov_needle / cov_bg) if cov_bg else (0, 0)
            rgb = [round(BG[c] * (1 - lf - ln) + FRAME[c] * lf + NEEDLE[c] * ln) for c in range(3)]
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
    write_svg(OUT / "icon.svg")
    print("wrote", OUT / "icon.svg")
    for name, size, kw in [
        ("icon-192.png", 192, {}),
        ("icon-512.png", 512, {}),
        ("icon-maskable-512.png", 512, {"full_bleed": True, "glyph_scale": 0.72}),
        ("apple-touch-icon.png", 180, {"full_bleed": True, "glyph_scale": 0.82}),
    ]:
        write_png(OUT / name, render(size, ss=3, **kw), size)
        print("wrote", OUT / name)
