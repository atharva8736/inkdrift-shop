// Vercel serverless entry point: every /api/* request lands here and is handled by the Express app.
import { createRuntime } from '../src/runtime.js';

let ready;           // reused while the instance is warm
export default async function handler(req, res) {
  try {
    ready ??= createRuntime().catch((e) => { ready = undefined; throw e; });
    const { app } = await ready;
    return app(req, res);
  } catch (e) {
    console.error('[startup]', e.message);
    res.statusCode = e.code === 'NOT_CONFIGURED' ? 503 : 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: e.code ?? 'STARTUP_FAILED', message: e.code === 'NOT_CONFIGURED' ? e.message : 'The server could not start. Check the Vercel function logs.' } }));
  }
}
