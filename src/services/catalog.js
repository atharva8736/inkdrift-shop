const PACKS = [
  { id: 'old-money', n: 1, name: 'Old Money', file: 'Inkdrift_Vol1_Old_Money.zip', tag: 'Stripes, soft linen and one very blue sky.', w: ['Golf Bear', 'Stripe Bear', 'Cloud Rider', 'Glass Tower', 'Offline Luxury'] },
  { id: 'time', n: 2, name: 'Time', file: 'Inkdrift_Vol2_Time.zip', tag: 'Dials, cash and a clock you stopped obeying.', w: ['Flat Lay', 'Torn Cash', 'Late Dials', 'Nine to Five', 'Already Late'] },
  { id: 'machines', n: 3, name: 'Machines', file: 'Inkdrift_Vol3_Machines.zip', tag: 'Doors up, engines cooling, night garages.', w: ['Scissor Doors', 'Weekend Case', 'Scissor Doors II', 'Night Duffel', 'Garage Light'] },
  { id: 'late-nights', n: 4, name: 'Late Nights', file: 'Inkdrift_Vol4_Late_Nights.zip', tag: 'Taxis, bars and handwritten ambition.', w: ['Millionare', 'Taxi Hush', 'Two Drinks', 'Black Kit', 'Clear Coat'] },
];

// Idempotent: inserts what is missing and never overwrites prices you changed later.
export function seedCatalog(db) {
  const insP = db.prepare('INSERT OR IGNORE INTO products(id,type,name,tagline,price_paise,compare_at_paise,file_name,sort) VALUES (?,?,?,?,?,?,?,?)');
  const insW = db.prepare('INSERT OR IGNORE INTO wallpapers(id,pack_id,position,title,preview_desktop,preview_phone) VALUES (?,?,?,?,?,?)');
  const insI = db.prepare('INSERT OR IGNORE INTO product_items(product_id,item_product_id) VALUES (?,?)');
  const insC = db.prepare('INSERT OR IGNORE INTO coupons(code,percent) VALUES (?,?)');
  db.transaction(() => {
    PACKS.forEach((p, i) => {
      insP.run(p.id, 'pack', p.name, p.tag, 39900, 59900, p.file, i + 1);
      p.w.forEach((t, k) => insW.run(`${p.id}-${k + 1}`, p.id, k + 1, t, `img/d_Vol${p.n}_0${k + 1}.jpg`, `img/p_Vol${p.n}_0${k + 1}.jpg`));
    });
    insP.run('bundle', 'bundle', 'All 4 packs', 'Every volume, 20 wallpapers.', 99900, 159600, null, 10);
    PACKS.forEach((p) => insI.run('bundle', p.id));
    insC.run('INK10', 10); insC.run('INK15', 15); insC.run('INK20', 20);
  })();
}

export function listCatalog(db) {
  const products = db.prepare('SELECT id,type,name,tagline,price_paise,compare_at_paise FROM products WHERE active=1 ORDER BY sort').all();
  const wall = db.prepare('SELECT id,pack_id,position,title,preview_desktop,preview_phone FROM wallpapers ORDER BY pack_id,position').all();
  return products.map((p) => ({
    ...p,
    wallpapers: wall.filter((w) => w.pack_id === p.id),
    includes: p.type === 'bundle' ? db.prepare('SELECT item_product_id FROM product_items WHERE product_id=?').all(p.id).map((r) => r.item_product_id) : undefined,
  }));
}

// The packs a product delivers: a pack is itself, a bundle is its packs.
export function packsOf(db, productId) {
  const p = db.prepare('SELECT type FROM products WHERE id=?').get(productId);
  if (!p) return [];
  if (p.type === 'bundle') return db.prepare('SELECT item_product_id AS id FROM product_items WHERE product_id=?').all(productId).map((r) => r.id);
  return [productId];
}

export function ownedProductIds(db, userId) {
  return db.prepare('SELECT product_id FROM entitlements WHERE user_id=? AND revoked_at IS NULL').all(userId).map((r) => r.product_id);
}
