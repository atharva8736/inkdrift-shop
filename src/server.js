// Local / traditional-host server. On Vercel the entry point is api/index.js instead.
import { createRuntime } from './runtime.js';
try {
  const { cfg, app } = await createRuntime();
  app.listen(cfg.port, () => console.log(`Inkdrift listening on ${cfg.appUrl} (port ${cfg.port})`));
} catch (e) { console.error(e.message); process.exit(1); }
