"""Generate extension icons (16/32/48/128 px) for the GitHub Chinese extension.

Design: rounded square in GitHub blue gradient, white "中" glyph, subtle inner ring.
Uses Pillow only; no external assets.
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

_HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(_HERE), "icons")

# GitHub accent blues
BG_TOP = (31, 111, 235)     # #1f6feb
BG_BOTTOM = (9, 105, 218)   # #0969da
FG = (255, 255, 255)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",   # Microsoft YaHei Bold
    r"C:\Windows\Fonts\msyh.ttc",     # Microsoft YaHei
    r"C:\Windows\Fonts\simhei.ttf",   # SimHei
    r"C:\Windows\Fonts\arialbd.ttf",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def vertical_gradient(size: int, top, bottom) -> Image.Image:
    img = Image.new("RGB", (1, size))
    px = img.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        px[0, y] = (
            round(top[0] + (bottom[0] - top[0]) * t),
            round(top[1] + (bottom[1] - top[1]) * t),
            round(top[2] + (bottom[2] - top[2]) * t),
        )
    return img.resize((size, size), Image.NEAREST)


def rounded_mask(size: int, radius_ratio: float = 0.22) -> Image.Image:
    """Antialiased rounded-square mask."""
    scale = 4
    big = size * scale
    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    radius = int(big * radius_ratio)
    draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def build_icon(size: int) -> Image.Image:
    # Work at 4x then downscale for crisp AA on small sizes.
    ss = 4
    canvas = size * ss

    icon = vertical_gradient(canvas, BG_TOP, BG_BOTTOM).convert("RGBA")

    # Glyph: "中" slightly larger for tiny sizes so strokes survive downscaling.
    glyph_ratio = 0.80 if size <= 32 else 0.74
    font_size = int(canvas * glyph_ratio)
    font = load_font(font_size)

    text = "中"
    draw = ImageDraw.Draw(icon)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    # Optical centering: shift by bbox origin, then nudge for CJK baseline.
    x = (canvas - tw) / 2 - bbox[0]
    y = (canvas - th) / 2 - bbox[1]
    draw.text((x, y), text, font=font, fill=FG + (255,))

    # Inner hairline ring for definition against light/dark toolbars.
    ring = ImageDraw.Draw(icon)
    inset = canvas * 0.045
    ring.rounded_rectangle(
        [inset, inset, canvas - 1 - inset, canvas - 1 - inset],
        radius=int(canvas * 0.19),
        outline=(255, 255, 255, 60),
        width=max(1, int(canvas * 0.012)),
    )

    icon = icon.resize((size, size), Image.LANCZOS)
    icon.putalpha(rounded_mask(size))
    return icon


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        build_icon(size).save(path, "PNG", optimize=True)
        print(f"{path}  {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()
