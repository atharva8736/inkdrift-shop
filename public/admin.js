const app = document.getElementById('app'); let csrf = '', data = null, tab = 'review';
const inr = (p) => '₹' + (p / 100).toFixed(2);
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (t) => (t ? new Date(t).toLocaleString() : '–');
const TABS = [
  ['review', 'Needs your check', (o) => o.status === 'pending_verification'],
  ['pending', 'Waiting for payment', (o) => o.status === 'pending' || o.status === 'created'],
  ['paid', 'Verified', (o) => o.status === 'paid'],
  ['closed', 'Failed / expired', (o) => ['failed', 'expired', 'cancelled'].includes(o.status)],
];
const LABEL = { pending_verification: 'needs check', pending: 'waiting for payment', created: 'waiting for payment', paid: 'verified', failed: 'rejected', expired: 'expired', cancelled: 'cancelled' };
async function call(method, url) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: method === 'POST' ? '{}' : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error?.message || 'Request failed'); return j;
}
function card(o) {
  const fallback = o.utr && o.status !== 'paid';
  return `<div class="card ${o.status === 'pending_verification' ? 'wait' : ''}">
    <div class="row"><span class="big">${inr(o.amountPaise)}</span><span class="pill ${esc(o.status)}">${esc(LABEL[o.status] || o.status)}</span><span class="m">Order ${esc(o.id.slice(0, 8))} · ref ${esc(o.ref)}</span></div>
    <div>${esc(o.items.join(', '))}</div>
    <div class="m">${esc(o.name)} · ${esc(o.email)}</div>
    <div class="row">${o.utr ? `UTR <span class="utr">${esc(o.utr)}</span>` : '<span class="m">No UTR submitted</span>'}</div>
    <div class="m">Created ${esc(when(o.createdAt))} · UTR sent ${esc(when(o.utrSubmittedAt))} · Verified ${esc(when(o.verifiedAt))}</div>
    <div class="m">Verification: ${esc(o.verification)}</div>
    ${fallback ? `<div class="row"><button class="ok" data-a="approve" data-id="${esc(o.id)}">${o.status === 'pending_verification' ? 'Approve' : 'Approve anyway'}</button>${o.status === 'pending_verification' ? `<button class="no" data-a="reject" data-id="${esc(o.id)}">Reject</button>` : ''}</div>` : ''}</div>`;
}
function render() {
  const { orders, totals, deadlines } = data;
  app.innerHTML = `<div class="sum"><div><b>${inr(totals.verifiedPaise)}</b><span>verified</span></div><div><b>${inr(totals.awaitingPaise)}</b><span>waiting for your check</span></div></div>
   <p class="m">Unpaid orders expire after ${deadlines.payMinutes} minutes. Submitted UTRs you don't check expire after ${deadlines.verifyHours} hours (you can still approve them later). Personal UPI IDs have no API to confirm a credit, so approval compares your bank history; the buttons are the fallback, not the automatic check.</p>
   <div class="tabs">${TABS.map(([k, l, f]) => `<button class="tab ${tab === k ? 'on' : ''}" data-t="${k}">${l} <span class="n">${orders.filter(f).length}</span></button>`).join('')}</div>
   ${orders.filter(TABS.find((t) => t[0] === tab)[2]).map(card).join('') || '<p class="m">Nothing here.</p>'}`;
  app.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => { tab = b.dataset.t; render(); });
  app.querySelectorAll('button[data-a]').forEach((b) => b.onclick = async () => {
    if (!confirm(`${b.dataset.a === 'approve' ? 'Approve' : 'Reject'} this payment? Only approve if you see the credit in your UPI history.`)) return;
    b.disabled = true; try { await call('POST', `/api/admin/orders/${b.dataset.id}/${b.dataset.a}`); load(); } catch (e) { alert(e.message); b.disabled = false; }
  });
}
async function load() {
  const me = await (await fetch('/api/me', { credentials: 'same-origin' })).json(); csrf = me.csrfToken || '';
  if (!me.user) { app.innerHTML = '<p>Please <a href="/#login" style="color:#c9a227">log in</a> with your admin account first, then reload this page.</p>'; return; }
  if (!me.isAdmin) { app.innerHTML = '<p>This account is not an admin. Add its email to ADMIN_EMAILS in Vercel.</p>'; return; }
  data = await call('GET', '/api/admin/orders');
  if (tab === 'review' && !data.orders.some((o) => o.status === 'pending_verification') && data.orders.length) tab = data.orders.some((o) => o.status === 'pending' || o.status === 'created') ? 'pending' : 'paid';
  render();
}
load(); setInterval(load, 30000);
