import { HttpError } from '../lib/http.js';

// Server-to-server client for the YOUPI PG payment API. The merchant key never reaches the browser.
export function createYoupiClient(cfg) {
  const y = cfg.youpi;
  async function call(path, { method = 'GET', body, idempotencyKey } = {}) {
    const headers = { 'X-Merchant-Id': y.merchantId, 'X-Merchant-Key': y.apiKey };
    if (body) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res;
    try {
      res = await fetch(`${y.apiUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(y.timeoutMs) });
    } catch (e) {
      throw new HttpError(502, 'GATEWAY_UNREACHABLE', 'The payment service is unreachable. Please try again shortly.', { cause: e.message });
    }
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) throw new HttpError(res.status === 409 ? 409 : 502, res.status === 409 ? 'GATEWAY_BUSY' : 'GATEWAY_ERROR',
      res.status === 409 ? 'Another payment is in progress for this account. Finish or cancel it first.' : 'The payment service rejected the request.',
      { upstreamStatus: res.status, upstream: json });
    return json;
  }
  const rupees = (paise) => (paise / 100).toFixed(2);
  return {
    createPayment: ({ orderId, amountPaise, customer, returnUrl, metadata }) => call('/api/v1/payments', {
      method: 'POST', idempotencyKey: `inkdrift-${orderId}`,
      body: { orderId, amount: rupees(amountPaise), currency: 'INR', customer, returnUrl, description: `Inkdrift order ${orderId.slice(0, 8)}`, metadata },
    }),
    getPayment: (paymentId) => call(`/api/v1/payments/${encodeURIComponent(paymentId)}`),
    cancelPayment: (paymentId) => call(`/api/v1/checkout/${encodeURIComponent(paymentId)}/cancel`, { method: 'POST', body: {} }),
  };
}
