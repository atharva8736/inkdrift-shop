const app = document.getElementById('app'); let csrf = '';
const inr = (p) => '₹' + (p / 100).toFixed(2);
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function call(method, url) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: method === 'POST' ? '{}' : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error?.message || 'Request failed'); return j;
}
async function load() {
  const me = await (await fetch('/api/me', { credentials: 'same-origin' })).json(); csrf = me.csrfToken || '';
  if (!me.user) { app.innerHTML = '<p>Please <a href="/#login" style="color:#c9a227">log in</a> with your admin account first, then reload this page.</p>'; return; }
  if (!me.isAdmin) { app.innerHTML = '<p>This account is not an admin. Add its email to ADMIN_EMAILS in Vercel.</p>'; return; }
  const { orders } = await call('GET', '/api/admin/orders');
  if (!orders.length) { app.innerHTML = '<p class="m">No UPI orders yet.</p>'; return; }
  app.innerHTML = orders.map((o) => `<div class="card ${o.status === 'pending_verification' ? 'wait' : ''}">
    <div class="row"><span class="big">${inr(o.amountPaise)}</span><span class="pill ${esc(o.status)}">${esc(o.status.replace('_', ' '))}</span><span class="m">${new Date(o.createdAt).toLocaleString()}</span></div>
    <div>${esc(o.items.join(', '))}</div><div class="m">${esc(o.name)} · ${esc(o.email)} · ref ${esc(o.ref)}</div>
    <div class="row">${o.utr ? `UTR <span class="utr">${esc(o.utr)}</span>` : '<span class="m">No UTR submitted yet</span>'}
    ${o.status === 'pending_verification' ? `<button class="ok" data-a="approve" data-id="${esc(o.id)}">Approve</button><button class="no" data-a="reject" data-id="${esc(o.id)}">Reject</button>` : ''}</div></div>`).join('');
  app.querySelectorAll('button[data-a]').forEach((b) => b.onclick = async () => {
    if (!confirm(`${b.dataset.a === 'approve' ? 'Approve' : 'Reject'} this payment?`)) return;
    b.disabled = true; try { await call('POST', `/api/admin/orders/${b.dataset.id}/${b.dataset.a}`); load(); } catch (e) { alert(e.message); b.disabled = false; }
  });
}
load(); setInterval(load, 30000);
