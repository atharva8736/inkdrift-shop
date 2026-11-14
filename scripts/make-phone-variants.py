#!/usr/bin/env python3
"""Rebuilds the iPhone and Android files so the whole picture stays in frame.

A wide painting cannot be cropped to a tall screen without losing the subject. Instead the picture is placed
at a larger size across the phone's width and the painted background is continued above and below it
(LaMa inpainting, with the colour pulled back to the picture's own edge colour so plaster stays plaster).
Needs: torch, simple-lama-inpainting, scipy.   Usage: python3 scripts/make-phone-variants.py /path/to/originals
Both phones come from one tall 9:20 composition (Android); iPhone is that composition trimmed to 9:19.5.
"""
import sys, os, json
import numpy as np
from PIL import Image, ImageFilter
from scipy.ndimage import gaussian_filter, gaussian_filter1d
sys.path.insert(0, os.path.dirname(__file__))

ROOT = os.path.join(os.path.dirname(__file__), '..')
ORD = {5:('old-money',1),7:('old-money',2),12:('old-money',3),13:('old-money',4),20:('old-money',5),
       1:('time',1),4:('time',2),8:('time',3),10:('time',4),18:('time',5),
       2:('machines',1),3:('machines',2),14:('machines',3),15:('machines',4),17:('machines',5),
       6:('late-nights',1),9:('late-nights',2),11:('late-nights',3),16:('late-nights',4),19:('late-nights',5)}
WORK_W, WORK_H = 720, 1600                  # inpainting resolution (9:20)
OUT = {'android': (1440, 3200), 'iphone': (1290, 2796)}
BIAS = {16: 1.0}                            # picture 16 is cut off at the bottom: put all new paint above it

def window(im, wc):
    g = np.asarray(im.convert('L').filter(ImageFilter.GaussianBlur(2)), float)
    e = np.abs(np.diff(g, axis=1)).sum(0); e = np.append(e, e[-1]); c = np.concatenate([[0], np.cumsum(e)])
    return int(np.argmax(c[wc:] - c[:-wc]))

def band(a, top, frac=0.07):
    n = max(8, int(a.shape[0] * frac)); b = a[:n] if top else a[-n:]
    v = gaussian_filter(b, (2, 1.5, 0)).std(axis=0).mean()
    return gaussian_filter1d(np.median(b, axis=0), 2, axis=0), v

def compose(lama, src, num):
    im = Image.open(src).convert('RGB'); im = im.crop((0, 6, im.width, im.height - 6))   # drop the painting's own edge rows, they read as a seam
    # first measure how plain the edges are; busy scenes use a narrower window so less has to be invented
    wc = 1000
    x = window(im, wc)
    probe = np.asarray(im.crop((x, 0, x + wc, im.height))).astype(float)
    if min(band(probe, True)[1], band(probe, False)[1]) > 9: wc = 860; x = window(im, wc)
    def build(W, H):
        crop = im.crop((x, 0, x + wc, im.height)).resize((W, round(im.height * W / wc)), Image.LANCZOS)
        a = np.asarray(crop).astype(float); h = a.shape[0]; t = round((H - h) * BIAS.get(num, 0.45))
        return crop, a, h, t
    crop, a, h, t = build(WORK_W, WORK_H)
    cv = Image.new('RGB', (WORK_W, WORK_H), (127, 127, 127)); cv.paste(crop, (0, t))
    m = Image.new('L', (WORK_W, WORK_H), 255); m.paste(0, (0, t + 6, WORK_W, t + h - 6))
    out = np.asarray(lama(cv, m))[:WORK_H, :WORK_W].astype(float)
    low = gaussian_filter(out, (WORK_H * 0.04, 3, 0)); hi = out - low
    for top, (y0, y1) in ((True, (0, t)), (False, (t + h, WORK_H))):
        if y1 <= y0: continue
        col, v = band(a, top); w = float(np.clip(1 - (v - 6) / 12, 0, 1))
        d = np.arange(y1 - y0); d = (y1 - y0 - 1 - d) if top else d
        ramp = np.clip(d / (WORK_H * 0.03), 0, 1)[:, None, None]
        tgt = np.broadcast_to(col[None], (y1 - y0, WORK_W, 3))
        fade = np.exp(-d / (WORK_H * 0.22))[:, None, None] if w < 0.6 else 1.0   # busy scenes: texture calms down with distance
        out[y0:y1] = low[y0:y1] * (1 - w * ramp) + tgt * (w * ramp) + hi[y0:y1] * fade
    fillimg = Image.fromarray(np.clip(out, 0, 255).astype('uint8')).resize(OUT['android'], Image.BICUBIC)
    # the real picture goes back in at full detail, with a short feather so the join disappears
    fw, fh = OUT['android']; _, a2, h2, t2 = build(fw, fh)
    full = np.asarray(fillimg).astype(float)
    rng = np.random.default_rng(num); full += rng.normal(0, 2.2, full.shape)          # fine grain so new paint matches the old
    mask = np.zeros((fh, 1), float); mask[t2 + 24:t2 + h2 - 24] = 1   # fill shows through the outer 24px, so the join is a blend
    mask = gaussian_filter1d(mask, 28, axis=0)[:, :, None]
    padded = full.copy(); padded[t2:t2 + h2] = a2
    padded[:t2] = a2[0]; padded[t2 + h2:] = a2[-1]      # extend the edge rows so the blend never mixes in black
    res = padded * mask + full * (1 - mask)
    return Image.fromarray(np.clip(res, 0, 255).astype('uint8')), (x, wc, h2 / im.height * 1.0, fw / wc)

def main(src_dir, out_dir=os.path.join(ROOT, 'private', 'variants'), only=None):
    from simple_lama_inpainting import SimpleLama
    lama = SimpleLama(); mp = os.path.join(out_dir, 'manifest.json'); man = json.load(open(mp))
    for num, (pack, pos) in sorted(ORD.items(), key=lambda kv: kv[1]):
        if only and num not in only: continue
        wid = f'{pack}-{pos}'; tall, (x, wc, _, scale) = compose(lama, os.path.join(src_dir, f'Wallpaper_{num:02d}.png'), num)
        # iPhone is slightly less tall: trim the new paint at the top and bottom, then resize uniformly
        th = round(tall.width / (1290 / 2796)); trim = (tall.height - th) // 2
        for dev, img in (('android', tall), ('iphone', tall.crop((0, trim, tall.width, trim + th)).resize(OUT['iphone'], Image.LANCZOS))):
            p = os.path.join(out_dir, wid, f'{dev}.jpg'); img.save(p, 'JPEG', quality=90, optimize=True, progressive=True)
            for m in man:
                if m['wallpaper'] == wid and m['device'] == dev:
                    m.update(width=OUT[dev][0], height=OUT[dev][1], crop=[x, 0, wc, 941], upscale=round(OUT[dev][0] / wc, 2), rebuilt=True, bytes=os.path.getsize(p))
        print(wid, flush=True)
    json.dump(man, open(mp, 'w'), indent=1)

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.', only=[int(n) for n in sys.argv[2:]] or None)
