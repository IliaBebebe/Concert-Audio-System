"""Regenerate the committed, version-neutral NSIS artwork (requires Pillow).

Run from any directory: python scripts/generate-installer-art.py
The installer itself and CI builds only need the resulting 24-bit BMP files.
"""

from math import pi, sin
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
SURFACE = "#181818"
BLUE = (120, 168, 237)
TEAL = (129, 191, 185)


def logo_on(image, box):
    logo = Image.open(ROOT / "assets/cas-logo-transparent.png").convert("RGBA")
    logo = logo.crop(logo.getbbox())
    logo.thumbnail((box[2], box[3]), Image.Resampling.LANCZOS)
    position = (box[0] + (box[2] - logo.width) // 2, box[1] + (box[3] - logo.height) // 2)
    image.paste(logo, position, logo)


def waveform(draw, top, color, phase):
    for index in range(36):
        envelope = sin(index / 35 * pi)
        height = 8 + envelope * (18 + 58 * abs(sin(index * 0.63 + phase)))
        x = 40 + index * 7
        fill = color if index % 3 else tuple(round(value * 0.58) for value in color)
        draw.rounded_rectangle((x, top - height / 2, x + 3, top + height / 2), radius=1, fill=fill)


def main():
    # Twice the standard NSIS sizes, scaled by MUI for the current display DPI.
    sidebar = Image.new("RGB", (328, 628), SURFACE)
    draw = ImageDraw.Draw(sidebar)
    logo_on(sidebar, (36, 48, 256, 144))
    draw.rounded_rectangle((24, 236, 304, 352), radius=12, fill="#1f1f1f", outline="#313131")
    waveform(draw, 294, BLUE, 0)
    draw.rounded_rectangle((24, 368, 304, 484), radius=12, fill="#1f1f1f", outline="#313131")
    waveform(draw, 426, TEAL, 1.8)
    draw.rounded_rectangle((40, 536, 168, 540), radius=2, fill="#313131")
    draw.rounded_rectangle((92, 522, 110, 554), radius=4, fill="#b9b9be")
    for row in range(3):
        for column in range(4):
            x, y = 208 + column * 19, 518 + row * 14
            active = (row, column) in ((0, 2), (1, 1))
            draw.rounded_rectangle((x, y, x + 14, y + 9), radius=2,
                                   fill=TEAL if active else "#313131")
    sidebar.save(ROOT / "assets/installer-sidebar.bmp")

    header = Image.new("RGB", (300, 114), "white")
    draw = ImageDraw.Draw(header)
    draw.rounded_rectangle((48, 12, 280, 102), radius=12, fill=SURFACE)
    logo_on(header, (64, 18, 200, 78))
    header.save(ROOT / "build/installerHeader.bmp")
    print("Generated NSIS sidebar (328x628) and header (300x114), RGB/24-bit.")


if __name__ == "__main__":
    main()
