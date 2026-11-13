// All configuration comes from environment variables. Nothing secret is ever sent to the browser.
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export function loadConfig(env = process.env, overrides = {}) {
  const port = int(env.PORT, 3000);
  const cfg = {
    env: env.NODE_ENV || 'development',
    port,
    appUrl: (env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    dbPath: env.DATABASE_PATH || './data/inkdrift.sqlite',
    packsDir: env.PACKS_DIR || './private/packs',
    publicDir: env.PUBLIC_DIR || './public',
    trustProxy: env.TRUST_PROXY === undefined ? 1 : int(env.TRUST_PROXY, 1),
    sessionSecret: env.SESSION_SECRET || '',
    sessionTtlMs: int(env.SESSION_TTL_DAYS, 30) * 86_400_000,
    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      authUrl: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    },
    email: {
      apiKey: env.RESEND_API_KEY || '',
      from: env.EMAIL_FROM || '',
      apiUrl: env.RESEND_API_URL || 'https://api.resend.com/emails',
      brand: env.BRAND_NAME || 'Inkdrift',
    },
    otp: {
      ttlMs: int(env.OTP_TTL_SECONDS, 300) * 1000,
      maxAttempts: int(env.OTP_MAX_ATTEMPTS, 5),
      resendCooldownMs: int(env.OTP_RESEND_COOLDOWN_SECONDS, 60) * 1000,
      maxSendsPerHour: int(env.OTP_MAX_SENDS_PER_HOUR, 5),
    },
    youpi: {
      apiUrl: (env.YOUPI_API_URL || '').replace(/\/+$/, ''),
      merchantId: env.YOUPI_MERCHANT_ID || '',
      apiKey: env.YOUPI_MERCHANT_API_KEY || '',
      webhookSecret: env.YOUPI_WEBHOOK_SECRET || '',
      // 'observed'   = unlock on a bank-alert match (OBSERVED_SUCCESS) or statement match (RECONCILED)
      // 'reconciled' = unlock only after the gateway admin imports a bank statement (RECONCILED)
      unlockPolicy: env.YOUPI_UNLOCK_POLICY === 'reconciled' ? 'reconciled' : 'observed',
      webhookMaxAgeMs: int(env.YOUPI_WEBHOOK_MAX_AGE_MINUTES, 180) * 60_000,
      timeoutMs: int(env.YOUPI_TIMEOUT_MS, 15_000),
    },
    orders: {
      pendingWindowMs: int(env.ORDER_PENDING_WINDOW_MINUTES, 15) * 60_000,
      maxUnlocksPerUserPerDay: int(env.MAX_PAID_ORDERS_PER_USER_PER_DAY, 10),
    },
  };
  for (const [k, v] of Object.entries(overrides)) {
    cfg[k] = typeof v === 'object' && !Array.isArray(v) && v ? { ...cfg[k], ...v } : v;
  }
  return cfg;
}

export function validateConfig(cfg) {
  const problems = [];
  const prod = cfg.env === 'production';
  if (cfg.sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 random characters');
  if (prod && !cfg.appUrl.startsWith('https://')) problems.push('APP_URL must be https:// in production');
  if (!cfg.email.apiKey || !cfg.email.from) problems.push('RESEND_API_KEY and EMAIL_FROM are required to send OTP emails');
  if (!cfg.youpi.apiUrl || !cfg.youpi.merchantId || !cfg.youpi.apiKey || !cfg.youpi.webhookSecret) {
    problems.push('YOUPI_API_URL, YOUPI_MERCHANT_ID, YOUPI_MERCHANT_API_KEY and YOUPI_WEBHOOK_SECRET are required for payments');
  }
  if (!!cfg.google.clientId !== !!cfg.google.clientSecret) problems.push('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither');
  return problems;
}
