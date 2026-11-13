#!/usr/bin/env python3
"""Builds the PUBLIC, watermarked preview images (public/img) from the clean sources in private/preview-src.

Visitors who have not bought a pack only ever receive these files: low-resolution, compressed, with a repeating
diagonal INKdrift watermark and a "PREVIEW ONLY" band baked into the pixels (so it cannot be removed with CSS or devtools).
Clean sources stay in private/preview-src and are served only to owners via /api/preview.
Usage: python3 scripts/make-previews.py
"""
import glob, os, math
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'private', 'preview-src')
OUT = os.path.join(ROOT, 'public', 'img')
FONT_CANDIDATES = [
    '/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]
FONT = next((f for f in FONT_CANDIDATES if os.path.exists(f)), None)
WIDTH = {'d': 1100, 'p': 450}      # preview width by kind (desktop / phone), far below the 4K originals
BRAND = 'INKdrift'
BAND = 'PREVIEW ONLY  -  PURCHASE TO DOWNLOAD'


def font(size):
    return ImageFont.truetype(FONT, size) if FONT else ImageFont.load_default()


def tile_layer(w, h, size, step_x, step_y, text, alpha):
    """A rotated, repeating text pattern covering the whole image (drawn on a larger canvas, then rotated)."""
    diag = int(math.hypot(w, h)) + 40
    layer = Image.new('RGBA', (diag, diag), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    f = font(size)
    row = 0
    for y in range(-step_y, diag + step_y, step_y):
        off = (step_x // 2) if row % 2 else 0
        for x in range(-step_x, diag + step_x, step_x):
            xy = (x + off, y)
            d.text(xy, text, font=f, fill=(0, 0, 0, int(alpha * 0.7)), stroke_width=2, stroke_fill=(0, 0, 0, int(alpha * 0.7)))
            d.text(xy, text, font=f, fill=(255, 255, 255, alpha))
        row += 1
    layer = layer.rotate(24, resample=Image.BICUBIC)
    left, top = (diag - w) // 2, (diag - h) // 2
    return layer.crop((left, top, left + w, top + h))


def watermark(im):
    w, h = im.size
    base = im.convert('RGBA')
    unit = max(w, h)
    # 1) dense repeating brand watermark across the whole picture
    size = max(18, unit // 22)
    base = Image.alpha_composite(base, tile_layer(w, h, size, int(size * 5.2), int(size * 3.1), BRAND, 70))
    # 2) a translucent band with the preview notice, crossing the centre
    band_h = max(34, unit // 14)
    band = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    y0 = h // 2 - band_h // 2
    bd.rectangle([0, y0, w, y0 + band_h], fill=(5, 6, 9, 120))
    f = font(max(12, band_h // 3))
    tw = bd.textlength(BAND, font=f)
    bd.text(((w - tw) / 2, y0 + band_h // 2 - f.size * 0.62), BAND, font=f, fill=(255, 255, 255, 235))
    base = Image.alpha_composite(base, band)
    return base.convert('RGB')


def main():
    files = sorted(glob.glob(os.path.join(SRC, '*.jpg')))
    if not files:
        raise SystemExit('No clean sources in private/preview-src')
    os.makedirs(OUT, exist_ok=True)
    for path in files:
        name = os.path.basename(path)
        kind = name[0]
        im = Image.open(path).convert('RGB')
        w = WIDTH.get(kind, 1000)
        im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        out = watermark(im)
        out.save(os.path.join(OUT, name), 'JPEG', quality=68, optimize=True, progressive=True)
        print('wrote', name, out.size)


if __name__ == '__main__':
    main()
