"""Draws the app icon as PNGs and an SVG favicon. Standard library only.

An audio waveform (muted bars) with a blue wave running through it: the
recording goes in, the tempo curve comes out. Both the SVG and the PNGs are
rendered from the same 32x32 coordinates, so they match.

    python tools/make-icons.py      -> icons/*.png, icons/icon.svg
"""
import math
import struct
import zlib
from pathlib import Path

BG = (0x14, 0x14, 0x13)    # icon background (near-black, like the app page)
BARS = (0x8A, 0x88, 0x80)  # waveform bars (muted, so the wave reads on top)
WAVE = (0x4A, 0x9B, 0xF0)  # the tempo wave: the app's accent blue

# 32x32 viewBox, shared by the SVG and the raster renderer below.
BAR_HALF_HEIGHTS = [(7, 3), (11.5, 6), (16, 8), (20.5, 5), (25, 3)]  # (x, half height) around y=16
BAR_LINES = [[(x, 16 - h), (x, 16 + h)] for x, h in BAR_HALF_HEIGHTS]
BAR_W = 2.4
# One sine period as two cubic halves; controls at 4/3 of the amplitude (5) give a round crest.
WAVE_CUBICS = [
    [(5, 16), (8.9, 9.3), (12.1, 9.3), (16, 16)],
    [(16, 16), (19.9, 22.7), (23.1, 22.7), (27, 16)],
]
WAVE_W = 2.6

OUT = Path(__file__).resolve().parent.parent / "icons"


def hexcolor(c):
    return "#%02x%02x%02x" % c


def wave_d():
    d = "M%g,%g" % WAVE_CUBICS[0][0]
    for _, c1, c2, p in WAVE_CUBICS:
        d += " C%g,%g %g,%g %g,%g" % (*c1, *c2, *p)
    return d


def wave_points(steps=24):
    """The wave flattened to a polyline, for the raster renderer."""
    pts = [WAVE_CUBICS[0][0]]
    for p0, c1, c2, p1 in WAVE_CUBICS:
        for k in range(1, steps + 1):
            t = k / steps
            u = 1 - t
            pts.append(tuple(u ** 3 * p0[i] + 3 * u * u * t * c1[i] + 3 * u * t * t * c2[i] + t ** 3 * p1[i]
                             for i in range(2)))
    return pts


def write_svg(path, radius=7):
    bars = "\n".join(
        f'  <line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}" stroke="{hexcolor(BARS)}" stroke-width="{BAR_W}" stroke-linecap="round"/>'
        for a, b in BAR_LINES)
    path.write_text(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="{radius}" fill="{hexcolor(BG)}"/>
{bars}
  <path d="{wave_d()}" fill="none" stroke="{hexcolor(WAVE)}" stroke-width="{WAVE_W}" stroke-linecap="round"/>
</svg>
''', encoding="utf-8")


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def polyline_dist(px, py, pts):
    return min(seg_dist(px, py, *pts[i], *pts[i + 1]) for i in range(len(pts) - 1))


def render(size, *, glyph_scale=1.0, radius=7 / 32, full_bleed=False, ss=4):
    """RGBA rows. glyph_scale < 1 shrinks the glyph towards the centre (maskable safe zone)."""
    unit = size / 32
    bar_half, wave_half = BAR_W * unit * glyph_scale / 2, WAVE_W * unit * glyph_scale / 2
    cx = cy = 16 * unit

    def pt(x, y):
        return (cx + (x - 16) * unit * glyph_scale, cy + (y - 16) * unit * glyph_scale)

    bars = [[pt(*p) for p in line] for line in BAR_LINES]
    wave = [pt(*p) for p in wave_points()]
    r = radius * size
    reach = math.sqrt(2) / 2  # half a pixel diagonal: beyond this, no subsample can be covered

    rows = []
    for j in range(size):
        row = bytearray()
        for i in range(size):
            # Only supersample the shapes that come near this pixel; the rest is plain background.
            pc = (i + 0.5, j + 0.5)
            near_bars = [b for b in bars if polyline_dist(*pc, b) <= bar_half + reach]
            near_wave = polyline_dist(*pc, wave) <= wave_half + reach
            cov_bg = cov_bars = cov_wave = 0.0
            for sj in range(ss):
                for si in range(ss):
                    x, y = i + (si + 0.5) / ss, j + (sj + 0.5) / ss
                    if not full_bleed:
                        cxg, cyg = min(max(x, r), size - r), min(max(y, r), size - r)
                        if math.hypot(x - cxg, y - cyg) > r:
                            continue
                    cov_bg += 1
                    if near_wave and polyline_dist(x, y, wave) <= wave_half:
                        cov_wave += 1  # the wave is drawn on top of the bars
                    elif any(polyline_dist(x, y, b) <= bar_half for b in near_bars):
                        cov_bars += 1
            n = ss * ss
            a = cov_bg / n
            lb, lw = (cov_bars / cov_bg, cov_wave / cov_bg) if cov_bg else (0, 0)
            rgb = [round(BG[c] * (1 - lb - lw) + BARS[c] * lb + WAVE[c] * lw) for c in range(3)]
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
