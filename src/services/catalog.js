import fs from 'node:fs';

export const DEVICES = {
  iphone:  { label: 'iPhone',  orientation: 'Portrait',  ratio: '9:19.5', note: 'Modern iPhones' },
  android: { label: 'Android', orientation: 'Portrait',  ratio: '9:20',   note: 'Most Android phones' },
  windows: { label: 'Windows', orientation: 'Landscape', ratio: '16:9',   note: 'Laptops and PCs' },
  mac:     { label: 'Mac',     orientation: 'Landscape', ratio: '3024:1964', note: 'MacBook Pro 14-inch screen' },
};
export const DEVICE_IDS = Object.keys(DEVICES);

// Prices in paise (INR). One wallpaper for one device, one wallpaper for every device, a pack of five, all twenty.
export const PRICE = { wallpaper: 9900, wallpaperAll: 19900, pack: 39900, bundle: 99900 };

const PACKS = [
  { id: 'old-money', n: 1, roman: 'I', name: 'Old Money', tag: 'Stripes, soft linen and one very blue sky.', w: ['Golf Bear', 'Stripe Bear', 'Cloud Rider', 'Glass Tower', 'Offline Luxury'] },
  { id: 'time', n: 2, roman: 'II', name: 'Time', tag: 'Dials, cash and a clock you stopped obeying.', w: ['Flat Lay', 'Torn Cash', 'Late Dials', 'Nine to Five', 'Already Late'] },
  { id: 'machines', n: 3, roman: 'III', name: 'Machines', tag: 'Doors up, engines cooling, night garages.', w: ['Scissor Doors', 'Weekend Case', 'Scissor Doors II', 'Night Duffel', 'Garage Light'] },
  { id: 'late-nights', n: 4, roman: 'IV', name: 'Late Nights', tag: 'Taxis, bars and handwritten ambition.', w: ['Millionare', 'Taxi Hush', 'Two Drinks', 'Black Kit', 'Clear Coat'] },
];
export const VARIANT_DIR = new URL('../../private/variants/', import.meta.url);

function readManifest() {
  try { return JSON.parse(fs.readFileSync(new URL('manifest.json', VARIANT_DIR), 'utf8')); } catch { return []; }
}

// Idempotent: inserts what is missing and never overwrites prices you changed later.
export async function seedCatalog(db) {
  const st = [];
  const add = (sql, args) => st.push({ sql, args });
  const manifest = readManifest();
  const has = (wid, dev) => manifest.some((m) => m.wallpaper === wid && m.device === dev);
  const insP = 'INSERT OR IGNORE INTO products(id,type,name,tagline,price_paise,compare_at_paise,file_name,sort,base_id,device) VALUES (?,?,?,?,?,?,?,?,?,?)';
  // legacy rows keep working for old orders
  PACKS.forEach((p, i) => {
    add(insP, [p.id, 'pack', p.name, p.tag, 39900, 59900, null, i + 1, null, null]);
    p.w.forEach((t, k) => add('INSERT OR IGNORE INTO wallpapers(id,pack_id,position,title,preview_desktop,preview_phone) VALUES (?,?,?,?,?,?)',
      [`${p.id}-${k + 1}`, p.id, k + 1, t, `img/d_Vol${p.n}_0${k + 1}.jpg`, `img/p_Vol${p.n}_0${k + 1}.jpg`]));
  });
  add(insP, ['bundle', 'bundle', 'All 4 packs', 'Every volume, 20 wallpapers.', 99900, 159600, null, 10, null, null]);
  st.push({ sql: "UPDATE products SET active=0 WHERE base_id IS NULL AND type IN ('pack','bundle')", args: [] });
  for (const [code, pct] of [['INK10', 10], ['INK15', 15], ['INK20', 20]]) add('INSERT OR IGNORE INTO coupons(code,percent) VALUES (?,?)', [code, pct]);
  await db.client.batch(st, 'write');

  const st2 = [];
  const add2 = (sql, args) => st2.push({ sql, args });
  for (const m of manifest) {
    add2('INSERT OR REPLACE INTO variants(wallpaper_id,device,width,height,source_w,source_h,upscale,file) VALUES (?,?,?,?,?,?,?,?)',
      [m.wallpaper, m.device, m.width, m.height, m.source[0], m.source[1], m.upscale, m.file]);
  }
  let sort = 100;
  PACKS.forEach((p) => {
    p.w.forEach((t, k) => {
      const wid = `${p.id}-${k + 1}`;
      const devs = DEVICE_IDS.filter((d) => has(wid, d));
      for (const d of devs) add2(insP, [`${wid}~${d}`, 'wallpaper', `${t} · ${DEVICES[d].label}`, p.name, PRICE.wallpaper, null, null, sort++, wid, d]);
      if (devs.length > 1) add2(insP, [`${wid}~all`, 'wallpaper', `${t} · All devices`, p.name, PRICE.wallpaperAll, PRICE.wallpaper * devs.length, null, sort++, wid, 'all']);
    });
    for (const d of DEVICE_IDS) if (manifest.some((m) => m.wallpaper.startsWith(`${p.id}-`) && m.device === d))
      add2(insP, [`${p.id}~${d}`, 'pack', `Vol. ${p.roman} · ${p.name} · ${DEVICES[d].label}`, p.tag, PRICE.pack, PRICE.wallpaper * 5, null, sort++, p.id, d]);
  });
  for (const d of DEVICE_IDS) if (manifest.some((m) => m.device === d))
    add2(insP, [`bundle~${d}`, 'bundle', `All 20 · ${DEVICES[d].label}`, 'Every volume for one device.', PRICE.bundle, PRICE.wallpaper * 20, null, sort++, 'bundle', d]);
  for (let i = 0; i < st2.length; i += 80) await db.client.batch(st2.slice(i, i + 80), 'write');
}

export async function listCatalog(db) {
  const products = await db.prepare('SELECT id,type,name,tagline,price_paise,compare_at_paise,base_id,device FROM products WHERE active=1 ORDER BY sort').all();
  const wall = await db.prepare('SELECT id,pack_id,position,title,preview_desktop,preview_phone FROM wallpapers ORDER BY pack_id,position').all();
  const vars = await db.prepare('SELECT wallpaper_id,device,width,height,source_w,source_h,upscale FROM variants').all();
  return {
    devices: DEVICE_IDS.map((id) => ({ id, ...DEVICES[id] })),
    products,
    wallpapers: wall.map((w) => ({ ...w, variants: vars.filter((v) => v.wallpaper_id === w.id).map(({ wallpaper_id, ...v }) => v) })),
  };
}

// Which (wallpaper, device) files a product delivers. Computed from the variants that really exist.
export async function loadCoverage(db) {
  const wall = await db.prepare('SELECT id,pack_id FROM wallpapers').all();
  const vars = await db.prepare('SELECT wallpaper_id,device FROM variants').all();
  const have = new Set(vars.map((v) => `${v.wallpaper_id}|${v.device}`));
  const packOf = new Map(wall.map((w) => [w.id, w.pack_id]));
  return (p) => {
    const ws = p.type === 'wallpaper' ? [p.base_id] : p.type === 'pack' ? wall.filter((w) => w.pack_id === p.base_id).map((w) => w.id) : wall.map((w) => w.id);
    const ds = p.device === 'all' ? DEVICE_IDS : [p.device];
    const out = new Set();
    for (const w of ws) for (const d of ds) if (have.has(`${w}|${d}`)) out.add(`${w}|${d}`);
    return out;
  };
}

export async function ownedProducts(db, userId) {
  return db.prepare(`SELECT p.*, e.granted_at FROM entitlements e JOIN products p ON p.id=e.product_id WHERE e.user_id=? AND e.revoked_at IS NULL`).all(userId);
}
export async function ownedProductIds(db, userId) {
  return (await ownedProducts(db, userId)).map((r) => r.id);
}

// Does this user own a file for the wallpaper (any device when `device` is omitted)? Returns the variant row or null.
export async function accessibleVariant(db, userId, wallpaperId, device) {
  const v = await db.prepare('SELECT v.*, w.title, w.pack_id FROM variants v JOIN wallpapers w ON w.id=v.wallpaper_id WHERE v.wallpaper_id=? AND (? IS NULL OR v.device=?)').all(wallpaperId, device ?? null, device ?? null);
  if (!v.length) return null;
  const cov = await loadCoverage(db);
  const owned = await ownedProducts(db, userId);
  for (const row of v) for (const p of owned) if (cov(p).has(`${row.wallpaper_id}|${row.device}`)) return row;
  return null;
}
