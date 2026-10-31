"""Rasterize our native SVG primitives into ICO, ICNS and Linux PNG sizes.

Requires Pillow only for regeneration; release CI consumes committed assets.
"""
from pathlib import Path
from math import cos, sin, pi
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SCALE = 8


def scaled(values):
    return tuple(round(value * SCALE) for value in values)


def main():
    source = ET.parse(ROOT / 'build/icon.svg').getroot()
    image = Image.new('RGBA', (512 * SCALE, 512 * SCALE))
    draw = ImageDraw.Draw(image)
    for element in source:
        name = element.tag.split('}')[-1]
        a = element.attrib
        if name == 'rect':
            x, y, width, height = (float(a.get(key, 0)) for key in ('x', 'y', 'width', 'height'))
            draw.rounded_rectangle(scaled((x, y, x + width, y + height)),
                                   radius=round(float(a.get('rx', 0)) * SCALE),
                                   fill=a.get('fill'), outline=a.get('stroke'),
                                   width=max(1, round(float(a.get('stroke-width', 1)) * SCALE)))
        elif name == 'circle':
            cx, cy, radius = (float(a[key]) for key in ('cx', 'cy', 'r'))
            stroke = float(a['stroke-width'])
            start = float(a['transform'].split('(')[1].split()[0])
            end = start + float(a['stroke-dasharray'].split()[0]) / (2 * pi * radius) * 360
            extent = radius + stroke / 2
            draw.arc(scaled((cx - extent, cy - extent, cx + extent, cy + extent)),
                     start=start, end=end, fill=a['stroke'], width=round(stroke * SCALE))
            for angle in (start, end):
                x, y = cx + radius * cos(angle * pi / 180), cy + radius * sin(angle * pi / 180)
                draw.ellipse(scaled((x - stroke / 2, y - stroke / 2, x + stroke / 2, y + stroke / 2)), fill=a['stroke'])
        else:
            raise ValueError(f'Unsupported icon primitive: {name}')
    master = image.resize((1024, 1024), Image.Resampling.LANCZOS)
    assets = ROOT / 'assets'
    master.save(assets / 'app-icon.icns', format='ICNS')
    sizes = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
    folder = assets / 'icons'
    folder.mkdir(exist_ok=True)
    for size in sizes:
        master.resize((size, size), Image.Resampling.LANCZOS).save(folder / f'{size}x{size}.png')
    master.resize((512, 512), Image.Resampling.LANCZOS).save(assets / 'app-icon.png')
    master.save(assets / 'app-icon.ico', format='ICO', sizes=[(size, size) for size in sizes if size <= 256])
    print('Generated transparent ICO, ICNS, window PNG and nine Linux PNG sizes from build/icon.svg')


if __name__ == '__main__':
    main()
