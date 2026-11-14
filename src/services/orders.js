import { uuid } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { audit } from '../db.js';
import { loadCoverage, ownedProducts } from './catalog.js';

const OPEN = ['created', 'pending', 'pending_verification'];
const RECHECK = [...OPEN, 'failed', 'expired', 'cancelled'];     // late payments can still arrive after these

// Turns a gateway status into what it means for the order. Only a UPI payment can ever unlock content.
export function classify(policy, g) {
  const names = [g.event, g.status].map((x) => String(x ?? '').toUpperCase());
  const settle = String(g.settlementState ?? '').toUpperCase();
  const upi = String(g.method ?? '').toUpperCase() === 'UPI';
  if (upi && (names.includes('RECONCILED') || settle === 'RECONCILED')) return 'paid';
  if (policy === 'observed' && upi && settle !== 'NOT_BANK_SETTLEMENT' && names.includes('OBSERVED_SUCCESS')) return 'paid';
  if (names.includes('MANUAL_REVIEW')) return 'review';
  if (names.includes('CANCELLED')) return 'cancelled';
  if (names.includes('EXPIRED')) return 'expired';
  if (names.includes('FAILED')) return 'failed';
  return 'pending';
}
const STATUS_FOR = { paid: 'paid', review: 'pending_verification', cancelled: 'cancelled', expired: 'expired', failed: 'failed', pending: 'pending' };

export function createOrderService({ db, cfg, youpi }) {
  const now = () => Date.now();

  async function quote(userId, rawItems, couponCode) {
    let ids = [...new Set((Array.isArray(rawItems) ? rawItems : []).map(String))].slice(0, 60);
    if (!ids.length) throw new HttpError(400, 'EMPTY_CART', 'Your cart is empty.');
    const prods = new Map((await db.prepare("SELECT * FROM products WHERE active=1 AND type IN ('wallpaper','pack','bundle') AND device IS NOT NULL").all()).map((p) => [p.id, p]));
    for (const id of ids) if (!prods.has(id)) throw new HttpError(400, 'UNKNOWN_PRODUCT', 'One of the items is not available (for example a device version that does not exist).');
    const cov = await loadCoverage(db);
    const covers = new Map(ids.map((id) => [id, cov(prods.get(id))]));
    for (const id of ids) if (!covers.get(id).size) throw new HttpError(400, 'NOT_AVAILABLE', 'That version is not available for this device.');
    const subset = (a, b) => [...a].every((x) => b.has(x));
    // An item whose files are all inside another item in the cart is not charged twice (the bigger one wins).
    ids = ids.filter((id) => !ids.some((o) => o !== id && subset(covers.get(id), covers.get(o)) && (covers.get(o).size > covers.get(id).size || o < id)));
    const have = new Set();
    for (const p of await ownedProducts(db, userId)) for (const k of cov(p)) have.add(k);
    for (const id of ids) if (subset(covers.get(id), have)) throw new HttpError(409, 'ALREADY_OWNED', `You already own ${prods.get(id).name}.`);
    const subtotal = ids.reduce((s, id) => s + prods.get(id).price_paise, 0);
    let percent = 0, code = null;
    if (couponCode) {
      const c = await db.prepare('SELECT * FROM coupons WHERE code=? AND active=1').get(String(couponCode).trim().toUpperCase());
      if (!c) throw new HttpError(400, 'BAD_COUPON', 'That discount code is not valid.');
      percent = c.percent; code = c.code;
    }
    const discount = Math.floor((subtotal * percent) / 100);
    const amount = subtotal - discount;
    if (amount < 100) throw new HttpError(400, 'BAD_AMOUNT', 'The order total is too low.');
    return { ids, prods, subtotal, discount, amount, code, itemsKey: [...ids].sort().join(',') };
  }

  async function view(order, { withCheckout = false } = {}) {
    const items = (await db.prepare('SELECT product_id, name, price_paise FROM order_items WHERE order_id=?').all(order.id))
      .map((i) => ({ productId: i.product_id, name: i.name, pricePaise: i.price_paise }));
    const pay = await db.prepare('SELECT * FROM payments WHERE order_id=?').get(order.id);
    return {
      id: order.id, status: order.status, currency: order.currency, subtotalPaise: order.subtotal_paise,
      discountPaise: order.discount_paise, amountPaise: order.amount_paise, couponCode: order.coupon_code,
      createdAt: order.created_at, paidAt: order.paid_at, items,
      payment: pay ? {
        transactionId: pay.provider_payment_id, status: pay.status, utr: pay.utr, method: pay.method,
        checkoutUrl: withCheckout && OPEN.includes(order.status) ? pay.checkout_url : undefined,
      } : null,
    };
  }

  const getOwn = async (userId, id) => {
    const o = await db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(id, userId);
    if (!o) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    return o;
  };

  async function grant(order) {
    const ins = db.prepare('INSERT OR IGNORE INTO entitlements(user_id,product_id,order_id,granted_at) VALUES (?,?,?,?)');
    const t = now();
    for (const { product_id } of await db.prepare('SELECT product_id FROM order_items WHERE order_id=?').all(order.id)) {
      await ins.run(order.user_id, product_id, order.id, t);
    }
    // Re-buying after a revoke restores access.
    await db.prepare('UPDATE entitlements SET revoked_at=NULL, order_id=? WHERE user_id=? AND revoked_at IS NOT NULL AND product_id IN (SELECT product_id FROM entitlements WHERE order_id=?)').run(order.id, order.user_id, order.id);
  }

  // The single place where a gateway state changes an order. Runs in one transaction and is safe to repeat.
  function applyGatewayState(orderId, gw, source) {
    return db.transaction(async () => {
      const order = await db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      const pay = await db.prepare('SELECT * FROM payments WHERE order_id=?').get(orderId);
      if (!order || !pay) return { changed: false, reason: 'unknown' };
      const t = now();
      const outcome = classify(cfg.youpi.unlockPolicy, gw);
      const patch = { status: String(gw.status ?? pay.status), event: gw.event ?? pay.event, settle: gw.settlementState ?? pay.settlement_state, method: gw.method ?? pay.method, utr: gw.utr ?? pay.utr };
      await db.prepare('UPDATE payments SET status=?, event=?, settlement_state=?, method=?, utr=?, updated_at=?, last_checked_at=? WHERE id=?')
        .run(patch.status, patch.event, patch.settle, patch.method, patch.utr, t, t, pay.id);
      if (order.status === 'paid') return { changed: false, reason: 'already_paid' };       // duplicate event
      if (outcome === 'paid') {
        if (gw.amountPaise !== undefined && Number(gw.amountPaise) !== order.amount_paise) {
          await audit(db, 'system', 'amount_mismatch', orderId, { expected: order.amount_paise, got: gw.amountPaise, source });
          return { changed: false, reason: 'amount_mismatch' };
        }
        const { c } = await db.prepare("SELECT COUNT(*) c FROM orders WHERE user_id=? AND status='paid' AND paid_at > ?").get(order.user_id, t - 86_400_000);
        if (c >= cfg.orders.maxUnlocksPerUserPerDay) {
          await db.prepare("UPDATE orders SET status='pending_verification', updated_at=? WHERE id=?").run(t, orderId);
          await audit(db, 'system', 'velocity_hold', orderId, { paidLast24h: c });
          return { changed: true, status: 'pending_verification', reason: 'velocity_hold' };
        }
        const res = await db.prepare("UPDATE orders SET status='paid', paid_at=?, updated_at=? WHERE id=? AND status != 'paid'").run(t, t, orderId);
        if (res.changes === 0) return { changed: false, reason: 'already_paid' };
        await db.prepare('UPDATE payments SET verified_at=? WHERE id=?').run(t, pay.id);
        await grant(order);
        await audit(db, 'system', 'order_paid', orderId, { source, event: gw.event ?? gw.status, late: !OPEN.includes(order.status) });
        return { changed: true, status: 'paid' };
      }
      const next = STATUS_FOR[outcome];
      if (next === 'pending' || next === order.status) return { changed: false, reason: 'no_change' };
      await db.prepare('UPDATE orders SET status=?, updated_at=? WHERE id=?').run(next, t, orderId);
      return { changed: true, status: next };
    });
  }

  async function cancelSilently(order) {
    const pay = await db.prepare('SELECT * FROM payments WHERE order_id=?').get(order.id);
    if (pay) { try { await youpi.cancelPayment(pay.provider_payment_id); } catch { /* the session may already be closed */ } }
    await db.prepare("UPDATE orders SET status='cancelled', updated_at=? WHERE id=? AND status IN ('created','pending','pending_verification')").run(now(), order.id);
  }

  return {
    quote, view, classify: (g) => classify(cfg.youpi.unlockPolicy, g), applyGatewayState,

    async create(user, { items, couponCode, idempotencyKey }) {
      const q = await quote(user.id, items, couponCode);
      const idem = idempotencyKey ? String(idempotencyKey).slice(0, 100) : null;
      if (idem) {
        const dup = await db.prepare('SELECT * FROM orders WHERE user_id=? AND idempotency_key=?').get(user.id, idem);
        if (dup) {
          if (dup.items_key !== q.itemsKey) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'That request key was already used for a different cart.');
          return { order: await view(dup, { withCheckout: true }), reused: true };
        }
      }
      // Never run two payments for one cart: reuse the live one, retire anything stale.
      for (const o of await db.prepare("SELECT * FROM orders WHERE user_id=? AND status IN ('created','pending') ORDER BY created_at DESC").all(user.id)) {
        const pay = await db.prepare('SELECT * FROM payments WHERE order_id=?').get(o.id);
        if (o.items_key === q.itemsKey && o.coupon_code === q.code && pay?.checkout_url && now() - o.created_at < cfg.orders.pendingWindowMs) {
          return { order: await view(o, { withCheckout: true }), reused: true };
        }
        await cancelSilently(o);
      }
      const id = uuid(), t = now();
      await db.transaction(async () => {
        await db.prepare(`INSERT INTO orders(id,user_id,status,subtotal_paise,discount_paise,amount_paise,coupon_code,items_key,idempotency_key,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, user.id, 'created', q.subtotal, q.discount, q.amount, q.code, q.itemsKey, idem, t, t);
        // Every line stores its own price snapshot; the total was computed on the server, never taken from the browser.
        for (const pid of q.ids) await db.prepare('INSERT INTO order_items(order_id,product_id,name,price_paise) VALUES (?,?,?,?)').run(id, pid, q.prods.get(pid).name, q.prods.get(pid).price_paise);
      });
      let gw;
      try {
        gw = await youpi.createPayment({
          orderId: id, amountPaise: q.amount, customer: { name: user.name, email: user.email },
          returnUrl: `${cfg.appUrl}/?order=${id}#done`, metadata: { orderId: id, itemsKey: q.itemsKey },
        });
        if (!gw?.paymentId || !gw?.checkoutUrl) throw new HttpError(502, 'GATEWAY_ERROR', 'The payment service returned an incomplete response.');
      } catch (e) {
        await db.prepare("UPDATE orders SET status='failed', updated_at=? WHERE id=?").run(now(), id);
        await audit(db, user.id, 'gateway_create_failed', id, { code: e.code, upstream: e.extra?.upstreamStatus });
        throw e;
      }
      await db.prepare(`INSERT INTO payments(id,order_id,provider,provider_payment_id,checkout_url,status,amount_paise,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(uuid(), id, 'youpi', String(gw.paymentId), gw.checkoutUrl, String(gw.status ?? 'INITIATED'), q.amount, now(), now());
      await db.prepare("UPDATE orders SET status='pending', updated_at=? WHERE id=?").run(now(), id);
      await audit(db, user.id, 'order_created', id, { amountPaise: q.amount, items: q.ids });
      return { order: await view(await db.prepare('SELECT * FROM orders WHERE id=?').get(id), { withCheckout: true }), reused: false };
    },

    // Polls the gateway at most every few seconds so a missed webhook never leaves a paid order stuck.
    async get(userId, id) {
      let o = await getOwn(userId, id);
      const pay = await db.prepare('SELECT * FROM payments WHERE order_id=?').get(id);
      if (pay && RECHECK.includes(o.status) && now() - o.created_at < 24 * 3_600_000 && now() - (pay.last_checked_at ?? 0) > 3000) {
        await db.prepare('UPDATE payments SET last_checked_at=? WHERE id=?').run(now(), pay.id);
        try {
          const gw = await youpi.getPayment(pay.provider_payment_id);
          if (String(gw.orderId ?? id) === id) await applyGatewayState(id, gw, 'poll');
        } catch (e) { console.error('[orders] gateway check failed:', e.message); }
        o = await getOwn(userId, id);
      }
      return view(o, { withCheckout: true });
    },

    async cancel(userId, id) {
      const o = await getOwn(userId, id);
      if (o.status === 'paid') throw new HttpError(409, 'ALREADY_PAID', 'This order is already paid.');
      if (OPEN.includes(o.status)) await cancelSilently(o);
      return view(await getOwn(userId, id));
    },

    async list(userId) {
      const rows = await db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(userId);
      return Promise.all(rows.map((o) => view(o)));
    },

    // Webhook path: the signed message is only a hint. The gateway is asked directly before anything unlocks.
    async applyWebhook(p) {
      const pay = await db.prepare('SELECT * FROM payments WHERE provider_payment_id=?').get(String(p.paymentId ?? ''));
      if (!pay) return { outcome: 'unknown_payment' };
      const order = await db.prepare('SELECT * FROM orders WHERE id=?').get(pay.order_id);
      if (String(p.orderId ?? '') !== order.id) { audit(db, 'system', 'webhook_order_mismatch', order.id, { got: p.orderId }); return { outcome: 'order_mismatch' }; }
      if (p.amountPaise !== undefined && Number(p.amountPaise) !== pay.amount_paise) {
        await audit(db, 'system', 'webhook_amount_mismatch', order.id, { expected: pay.amount_paise, got: p.amountPaise });
        return { outcome: 'amount_mismatch' };
      }
      const hint = classify(cfg.youpi.unlockPolicy, { event: p.event, status: p.status, settlementState: p.settlementState, method: 'UPI' });
      if (hint !== 'paid') {
        const r = await applyGatewayState(order.id, { event: p.event, status: p.status, settlementState: p.settlementState, utr: p.utr, amountPaise: p.amountPaise }, 'webhook');
        return { outcome: r.status ?? r.reason };
      }
      const gw = await youpi.getPayment(pay.provider_payment_id);        // throws => caller answers 503 and the gateway retries
      if (String(gw.orderId ?? '') !== order.id || Number(gw.amountPaise) !== pay.amount_paise) {
        await audit(db, 'system', 'confirm_mismatch', order.id, { gw: { orderId: gw.orderId, amountPaise: gw.amountPaise } });
        return { outcome: 'confirm_mismatch' };
      }
      if (classify(cfg.youpi.unlockPolicy, gw) !== 'paid') return { outcome: 'not_confirmed', retry: true };
      const r = await applyGatewayState(order.id, { ...gw, utr: gw.utr ?? p.utr }, 'webhook');
      return { outcome: r.status ?? r.reason };
    },

    // Everything the customer may download: one row per wallpaper file, plus ZIPs for multi-file purchases.
    async library(userId) {
      const cov = await loadCoverage(db);
      const owned = await ownedProducts(db, userId);
      const vars = new Map((await db.prepare('SELECT v.*, w.title, w.pack_id, w.position FROM variants v JOIN wallpapers w ON w.id=v.wallpaper_id').all()).map((v) => [`${v.wallpaper_id}|${v.device}`, v]));
      const files = new Map(), archives = [];
      for (const p of owned) {
        const keys = cov(p);
        for (const k of keys) {
          const v = vars.get(k);
          const cur = files.get(k);
          if (!cur || p.granted_at < cur.grantedAt) files.set(k, { wallpaperId: v.wallpaper_id, packId: v.pack_id, position: v.position, title: v.title, device: v.device, width: v.width, height: v.height, upscale: v.upscale, sourceWidth: v.source_w, sourceHeight: v.source_h, grantedAt: p.granted_at, url: `/api/file/${v.wallpaper_id}/${v.device}` });
        }
        if (keys.size > 1) archives.push({ productId: p.id, name: p.name, device: p.device, count: keys.size, grantedAt: p.granted_at, url: `/api/download/${p.id}` });
      }
      return { files: [...files.values()].sort((a, b) => b.grantedAt - a.grantedAt || a.packId.localeCompare(b.packId) || a.position - b.position), archives };
    },
  };
}
