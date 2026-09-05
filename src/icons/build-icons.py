#!/usr/bin/env python3
"""Generate the favicon / app-icon set from src/icons/zztop-source.png.

The source is green line art on black. We rebuild every icon from a luminance
mask so the strokes stay crisp and get recoloured to the site green, and so the
background is the site background (#0a0a0f) rather than the source's near-black.

Tab-sized icons (<=48px) use a crop of the centre figure's head: the full trio
turns to mush below ~64px, one hat + shades + beard stays readable.

  python3 src/icons/build-icons.py
"""
from PIL import Image
import numpy as np, subprocess, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "src/icons/zztop-source.png"
OUT = ROOT / "icons"

GREEN = (0x7C, 0xFF, 0xB0)   # --green, matches the site
BG = (0x0A, 0x0A, 0x0F)      # page background / theme-color

TRIO = (111, 155, 1190, 1162)   # tight bbox of the whole drawing
HEAD = (480, 165, 780, 520)     # centre figure: hat + shades + beard

def art(box, gamma=1.0):
    """Crop -> RGBA of the site green, alpha = stroke coverage."""
    a = np.asarray(Image.open(SRC).convert("RGB").crop(box)).astype(np.float32)
    alpha = a.max(axis=2) / 255.0
    if gamma != 1.0:
        alpha = alpha ** gamma          # <1 fattens thin strokes for small sizes
    rgba = np.zeros(alpha.shape + (4,), np.uint8)
    for i, c in enumerate(GREEN):
        rgba[..., i] = c
    rgba[..., 3] = (alpha * 255).round().astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")

def save(img, path):
    """Flatten and palette-quantize: the art is two colours plus antialiasing,
    so 128 colours is lossless to the eye and a fraction of the bytes."""
    img.convert("RGB").quantize(colors=128, method=Image.MEDIANCUT).save(path, optimize=True)

def square(img, size, pad=0.0, bg=BG):
    """Fit img into a size*size canvas, `pad` = fraction of the side left empty."""
    canvas = Image.new("RGBA", (size, size), bg + (255,))
    inner = max(1, int(round(size * (1 - pad))))
    w, h = img.size
    scale = min(inner / w, inner / h)
    r = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    canvas.alpha_composite(r, ((size - r.width) // 2, (size - r.height) // 2))
    return canvas

OUT.mkdir(exist_ok=True)
head = art(HEAD, gamma=0.55)  # thin strokes go dim when downscaled; fatten them
trio = art(TRIO)

# tab favicons — head crop, edge to edge
for n in (16, 32, 48):
    square(head, n, pad=0.02).convert("RGB").save(OUT / f"favicon-{n}.png")
# multi-resolution .ico at the root, for browsers that ask for /favicon.ico
subprocess.run(["convert", *[str(OUT / f"favicon-{n}.png") for n in (16, 32, 48)],
                str(ROOT / "favicon.ico")], check=True)

# iOS home screen — opaque (iOS squares off alpha itself), slight breathing room
save(square(trio, 180, pad=0.08), OUT / "apple-touch-icon.png")
# Android / PWA
save(square(trio, 192, pad=0.08), OUT / "icon-192.png")
save(square(trio, 512, pad=0.08), OUT / "icon-512.png")
# maskable: art inside the 80% safe zone so a circular mask can't clip it
save(square(trio, 512, pad=0.30), OUT / "maskable-512.png")

# social card, 1.91:1
og = Image.new("RGBA", (1200, 630), BG + (255,))
s = min(560 / trio.width, 560 / trio.height)
r = trio.resize((round(trio.width * s), round(trio.height * s)), Image.LANCZOS)
og.alpha_composite(r, ((1200 - r.width) // 2, (630 - r.height) // 2))
save(og, OUT / "og.png")

for p in sorted(OUT.iterdir()) + [ROOT / "favicon.ico"]:
    print(f"{p.relative_to(ROOT)}  {p.stat().st_size / 1024:.1f} KB")
