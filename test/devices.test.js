import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { boot, signupAndVerify, webhook } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = { iphone: [1290, 2796], android: [1440, 3200], windows: [3840, 2160], mac: [3024, 1964] };
const cookie = (c) => Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
const get = (c, url) => fetch(c.base + url, { headers: { cookie: cookie(c) } });

function jpegSize(buf) {                                   // reads the real pixel size from the JPEG header
  assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8);
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('no size');
}
function readZip(buf) {                                    // parses the central directory and verifies every CRC
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); const out = [];
  for (let k = 0; k < n; k++) {
    const crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const data = buf.subarray(off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28) + size);
    assert.equal(zlib.crc32(data), crc, `crc of ${name}`);
    out.push({ name, data }); p += 46 + nl;
  }
  return out;
}
const buy = (c, items) => c.post('/api/orders', { items });
async function pay(ctx, order) {
  const id = (await ctx.db.prepare('SELECT provider_payment_id p FROM payments WHERE order_id=?').get(order.id)).p;
  ctx.gw.set(id, { status: 'OBSERVED_SUCCESS', settlementState: 'NOT_RECONCILED', utr: '123456789012' });
  const w = await webhook(ctx, { event: 'OBSERVED_SUCCESS', settlementState: 'NOT_RECONCILED', orderId: order.id, amountPaise: order.amountPaise, paymentId: id, utr: '123456789012' });
  assert.equal(w.json.outcome, 'paid');
}
const purchase = async (ctx, c, sku) => { const r = await buy(c, [sku]); assert.equal(r.status, 201, r.text); await pay(ctx, r.json.order); return r.json.order; };

test('every device file really exists at its exact size and aspect ratio, and no two devices share an image', async () => {
  const ctx = await boot(); const cat = (await ctx.client().get('/api/catalog')).json; await ctx.close();
  assert.equal(cat.currency, 'INR'); assert.equal(cat.wallpapers.length, 20);
  const seen = new Set();
  for (const w of cat.wallpapers) {
    assert.deepEqual(w.variants.map((v) => v.device).sort(), ['android', 'iphone', 'mac', 'windows']);
    for (const v of w.variants) {
      const buf = fs.readFileSync(path.join(root, 'private/variants', w.id, `${v.device}.jpg`));
      assert.deepEqual(jpegSize(buf), SPEC[v.device]); assert.deepEqual([v.width, v.height], SPEC[v.device]);
      assert.equal(v.source_w, 1672); assert.ok(v.upscale > 1, 'files are labelled as upscaled');
      assert.ok(!seen.has(zlib.crc32(buf)), 'unique file'); seen.add(zlib.crc32(buf));
      // the public preview has the device's own ratio and is watermarked (so never the clean file)
      const pub = fs.readFileSync(path.join(root, 'public/img/v', `${w.id}-${v.device}.jpg`));
      const [pw, ph] = jpegSize(pub); assert.ok(Math.abs(pw / ph - v.width / v.height) < 0.01, 'preview ratio matches the device');
      assert.ok(pub.length < buf.length / 2);
    }
  }
  const price = (id) => cat.products.find((p) => p.id === id).price_paise;
  assert.equal(price('old-money-3~iphone'), 9900); assert.equal(price('old-money-3~all'), 19900); assert.equal(price('old-money~mac'), 39900); assert.equal(price('bundle~windows'), 99900);
});

for (const device of Object.keys(SPEC)) {
  test(`${device}: select → add → pay ₹99 → download the ${SPEC[device].join('×')} file`, async () => {
    const ctx = await boot(); const c = await signupAndVerify(ctx);
    const sku = `old-money-3~${device}`;
    const q = await c.post('/api/quote', { items: [sku] }); assert.equal(q.json.amountPaise, 9900);
    assert.equal((await get(c, `/api/file/old-money-3/${device}`)).status, 403);                    // locked before payment
    const order = await purchase(ctx, c, sku);
    assert.equal(order.amountPaise, 9900); assert.equal(ctx.gw.calls.find((x) => x[0] === 'create')[1].amountPaise, 9900);   // cart total == amount charged
    const lib = (await c.get('/api/library')).json;
    assert.deepEqual(lib.files.map((f) => [f.wallpaperId, f.device, f.width, f.height]), [['old-money-3', device, ...SPEC[device]]]);
    const r = await get(c, lib.files[0].url); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.match(r.headers.get('content-disposition'), new RegExp(`${SPEC[device].join('x')}\\.jpg`));
    assert.deepEqual(jpegSize(Buffer.from(await r.arrayBuffer())), SPEC[device]);
    for (const other of Object.keys(SPEC).filter((d) => d !== device)) assert.equal((await get(c, `/api/file/old-money-3/${other}`)).status, 403, `${other} stays locked`);
    assert.equal((await get(c, '/api/file/old-money-4/' + device)).status, 403);                     // other wallpapers stay locked
    const dl = await get(c, `/api/download/${sku}`); assert.equal(dl.headers.get('content-type'), 'image/jpeg');   // one file → plain JPG, not a ZIP
    await ctx.close();
  });
}

test('All Devices bundle: ₹199 and a ZIP with every available version at the right size', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  await purchase(ctx, c, 'time-2~all');
  const lib = (await c.get('/api/library')).json;
  assert.equal(lib.files.length, 4); assert.equal(lib.archives[0].count, 4);
  const entries = readZip(Buffer.from(await (await get(c, lib.archives[0].url)).arrayBuffer()));
  assert.deepEqual(entries.map((e) => e.name).sort(), ['Torn_Cash/Android_1440x3200.jpg', 'Torn_Cash/Mac_3024x1964.jpg', 'Torn_Cash/Windows_3840x2160.jpg', 'Torn_Cash/iPhone_1290x2796.jpg']);
  for (const e of entries) { const dev = e.name.split('/')[1].split('_')[0].toLowerCase(); assert.deepEqual(jpegSize(e.data), SPEC[dev]); }
  await ctx.close();
});

test('a pack or the whole collection is delivered for the chosen device only', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  await purchase(ctx, c, 'time~mac');
  let lib = (await c.get('/api/library')).json;
  assert.equal(lib.files.length, 5); assert.ok(lib.files.every((f) => f.device === 'mac' && f.packId === 'time'));
  const zip = readZip(Buffer.from(await (await get(c, '/api/download/time~mac')).arrayBuffer()));
  assert.equal(zip.length, 5); for (const e of zip) assert.deepEqual(jpegSize(e.data), SPEC.mac);
  assert.equal((await get(c, '/api/file/time-1/windows')).status, 403);
  // buying a single wallpaper that the pack already contains for the same device is refused as already owned
  assert.equal((await buy(c, ['time-3~mac'])).json.error.code, 'ALREADY_OWNED');
  await purchase(ctx, c, 'bundle~iphone');
  lib = (await c.get('/api/library')).json; assert.equal(lib.files.length, 25);
  await ctx.close();
});

test('unpaid, anonymous and other customers can never reach the files; an unavailable version cannot be bought', async () => {
  const ctx = await boot(); const anon = ctx.client(); const a = await signupAndVerify(ctx); const b = await signupAndVerify(ctx, 'Ravi Kumar', 'ravi@example.com');
  await purchase(ctx, a, 'machines-1~android');
  for (const url of ['/api/file/machines-1/android', '/api/preview/machines-1/android', '/api/download/machines-1~android']) {
    assert.equal((await anon.get(url)).status, 401, url);
    assert.equal((await get(b, url)).status, 403, url);
    assert.equal((await get(a, url)).status, 200, url);
  }
  assert.equal((await (await get(a, '/api/preview/machines-1/android')).headers.get('cache-control')), 'private, no-store');
  assert.equal((await b.get('/api/library')).json.files.length, 0);
  // a version that does not exist is refused instead of delivering a wrong-sized file
  await ctx.db.prepare("DELETE FROM variants WHERE wallpaper_id='machines-2' AND device='mac'").run();
  const r = await b.post('/api/quote', { items: ['machines-2~mac'] }); assert.equal(r.status, 400); assert.equal(r.json.error.code, 'NOT_AVAILABLE');
  const all = await b.post('/api/quote', { items: ['machines-2~all'] }); assert.equal(all.status, 200);       // the rest still sell
  await purchase(ctx, b, 'machines-2~all');
  assert.equal((await b.get('/api/library')).json.files.length, 3);
  assert.equal((await get(b, '/api/file/machines-2/mac')).status, 403);
  // no raw path or storage URL is ever exposed by the catalog
  const cat = JSON.stringify((await anon.get('/api/catalog')).json); assert.ok(!/private|variants\/|\.zip/.test(cat));
  await ctx.close();
});

test('INR totals: quote, order and the amount sent to the gateway always agree', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const items = ['old-money-1~iphone', 'old-money-2~android', 'time-1~all', 'machines~windows'];
  const q = (await c.post('/api/quote', { items, coupon: 'INK10' })).json;
  assert.equal(q.subtotalPaise, 9900 + 9900 + 19900 + 39900); assert.equal(q.discountPaise, 7960); assert.equal(q.amountPaise, 71640);
  const o = (await buy(c, items)).json.order; assert.equal(o.currency, 'INR');
  assert.equal(o.subtotalPaise, q.subtotalPaise); assert.equal(o.items.length, 4);
  assert.equal(ctx.gw.calls.find((x) => x[0] === 'create')[1].amountPaise, o.amountPaise);
  await ctx.close();
});
