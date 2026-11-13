#!/usr/bin/env python3
"""Builds the device-specific wallpaper files from the 20 original PNGs (1672x941, 16:9).

Rules: never stretch. Each device gets a real crop of the original at the device's exact aspect ratio,
positioned on the most detailed part of the picture, then resampled (Lanczos) to the device resolution.
Every file therefore records how much it was upscaled; the shop shows that honestly.

Usage: python3 scripts/make-variants.py /path/to/originals   (Wallpaper_01.png .. Wallpaper_20.png)
Output: private/variants/<wallpaper-id>/<device>.jpg and private/variants/manifest.json
"""
import json, sys, glob, os
import numpy as np
from PIL import Image, ImageFilter

DEVICES = {
    'iphone':  (1290, 2796),
    'android': (1440, 3200),
    'windows': (3840, 2160),
    'mac':     (3024, 1964),
}
# original file number -> (pack id, position); verified by image comparison against the existing previews
ORDER = {5:('old-money',1),7:('old-money',2),12:('old-money',3),13:('old-money',4),20:('old-money',5),
         1:('time',1),4:('time',2),8:('time',3),10:('time',4),18:('time',5),
         2:('machines',1),3:('machines',2),14:('machines',3),15:('machines',4),17:('machines',5),
         6:('late-nights',1),9:('late-nights',2),11:('late-nights',3),16:('late-nights',4),19:('late-nights',5)}

def best_window(im, ratio):
    """Crop box (x,y,w,h) with the exact target ratio, placed over the most detailed area."""
    W, H = im.size
    if ratio >= W / H:                       # wider than the source: use full width, trim height
        w, h = float(W), W / ratio
        gray = np.asarray(im.convert('L').filter(ImageFilter.GaussianBlur(2)), dtype=float)
        gy = np.abs(np.diff(gray, axis=0)).sum(axis=1)
        gy = np.append(gy, gy[-1]); span = int(round(h))
        if span >= H: return (0.0, 0.0, w, float(H))
        c = np.concatenate([[0], np.cumsum(gy)]); sc = c[span:] - c[:len(c) - span]
        y = int(np.argmax(sc)); y = min(y, H - h)
        return (0.0, float(y), w, h)
    h, w = float(H), H * ratio
    gray = np.asarray(im.convert('L').filter(ImageFilter.GaussianBlur(2)), dtype=float)
    gx = np.abs(np.diff(gray, axis=1)).sum(axis=0) + np.abs(np.diff(gray, axis=0)).sum(axis=0)[:W - 1] * 0.5
    gx = np.append(gx, gx[-1]); span = int(round(w))
    c = np.concatenate([[0], np.cumsum(gx)]); sc = c[span:] - c[:len(c) - span]
    centre = np.linspace(-1, 1, len(sc)); sc = sc * (1 - 0.15 * centre ** 2)      # slight pull toward the middle
    x = float(np.argmax(sc)); x = min(x, W - w)
    return (x, 0.0, w, h)

def main(src_dir, out_dir='private/variants'):
    manifest = []
    for n, (pack, pos) in sorted(ORDER.items(), key=lambda kv: (kv[1][0], kv[1][1])):
        im = Image.open(os.path.join(src_dir, f'Wallpaper_{n:02d}.png')).convert('RGB')
        wid = f'{pack}-{pos}'
        os.makedirs(os.path.join(out_dir, wid), exist_ok=True)
        for dev, (tw, th) in DEVICES.items():
            x, y, w, h = best_window(im, tw / th)
            out = im.resize((tw, th), Image.LANCZOS, box=(x, y, x + w, y + h))
            out = out.filter(ImageFilter.UnsharpMask(radius=1.4, percent=55, threshold=2))
            path = os.path.join(out_dir, wid, f'{dev}.jpg')
            out.save(path, 'JPEG', quality=90, optimize=True, progressive=True)
            manifest.append({'wallpaper': wid, 'device': dev, 'width': tw, 'height': th,
                             'source': [im.width, im.height], 'crop': [round(x, 2), round(y, 2), round(w, 2), round(h, 2)],
                             'upscale': round(tw / w, 2), 'file': f'{wid}/{dev}.jpg', 'bytes': os.path.getsize(path)})
    json.dump(manifest, open(os.path.join(out_dir, 'manifest.json'), 'w'), indent=1)
    print(len(manifest), 'files,', round(sum(m['bytes'] for m in manifest) / 1e6, 1), 'MB')

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
