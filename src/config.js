// All configuration comes from environment variables. Nothing secret is ever sent to the browser.
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export function loadConfig(env = process.env, overrides = {}) {
  const port = int(env.PORT, 3000);
  const cfg = {
    env: env.NODE_ENV || 'development',
    port,
    // On Vercel the production domain is known automatically; APP_URL overrides it (e.g. for a custom domain).
    appUrl: (env.APP_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${port}`)).replace(/\/+$/, ''),
    // Turso/libSQL in production (DATABASE_URL=libsql://...), a local SQLite file otherwise.
    dbUrl: env.DATABASE_URL || `file:${env.DATABASE_PATH || './data/inkdrift.sqlite'}`,
    dbAuthToken: env.DATABASE_AUTH_TOKEN || '',
    storage: {
      driver: env.PACK_STORAGE || (env.BLOB_READ_WRITE_TOKEN || env.VERCEL ? 'blob' : 'disk'),
      blobToken: env.BLOB_READ_WRITE_TOKEN || '',
    },
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
      provider: env.BREVO_API_KEY ? 'brevo' : 'resend',
      apiKey: env.BREVO_API_KEY || env.RESEND_API_KEY || '',
      from: env.EMAIL_FROM || '',
      apiUrl: env.EMAIL_API_URL || env.RESEND_API_URL || (env.BREVO_API_KEY ? 'https://api.brevo.com/v3/smtp/email' : 'https://api.resend.com/emails'),
      brand: env.BRAND_NAME || 'Inkdrift',
    },
    // Reject sign-ups whose email domain cannot receive mail (on by default in production).
    checkEmailDomain: env.CHECK_EMAIL_DOMAIN ? env.CHECK_EMAIL_DOMAIN === 'true' : env.NODE_ENV === 'production',
    otp: {
      ttlMs: int(env.OTP_TTL_SECONDS, 300) * 1000,
      maxAttempts: int(env.OTP_MAX_ATTEMPTS, 5),
      resendCooldownMs: int(env.OTP_RESEND_COOLDOWN_SECONDS, 60) * 1000,
      maxSendsPerHour: int(env.OTP_MAX_SENDS_PER_HOUR, 5),
    },
    // Manual UPI: customers pay your UPI ID and submit the UTR; an admin approves. Used when YOUPI is not configured.
    upi: { id: (env.UPI_ID || '').trim(), payeeName: (env.UPI_PAYEE_NAME || env.BRAND_NAME || 'Inkdrift').trim() },
    adminEmails: (env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
    youpi: {
      apiUrl: (env.YOUPI_API_URL || '').replace(/\/+$/, ''),
      merchantId: env.YOUPI_MERCHANT_ID || '00000000-0000-0000-0000-000000000001',   // YOUPI's seeded default merchant
      apiKey: env.YOUPI_MERCHANT_API_KEY || env.YOUPI_WEBHOOK_SECRET || '',   // YOUPI's merchant key is the merchant webhook secret
      webhookSecret: env.YOUPI_WEBHOOK_SECRET || '',
      // 'observed'   = unlock on a bank-alert match (OBSERVED_SUCCESS) or statement match (RECONCILED)
      // 'reconciled' = unlock only after the gateway admin imports a bank statement (RECONCILED)
      unlockPolicy: env.YOUPI_UNLOCK_POLICY === 'observed' ? 'observed' : 'reconciled',   // safe by default; set observed to unlock on a bank alert
      webhookMaxAgeMs: int(env.YOUPI_WEBHOOK_MAX_AGE_MINUTES, 180) * 60_000,
      timeoutMs: int(env.YOUPI_TIMEOUT_MS, 15_000),
    },
    orders: {
      pendingWindowMs: int(env.ORDER_PENDING_WINDOW_MINUTES, 15) * 60_000,
      // Manual UPI: an order nobody paid expires after this long; a submitted UTR the owner never checked expires after the second one.
      manualPendingMs: int(env.MANUAL_UPI_PAY_WINDOW_MINUTES, 60) * 60_000,
      manualVerifyMs: int(env.MANUAL_UPI_VERIFY_DEADLINE_HOURS, 48) * 3_600_000,
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
  if (prod && cfg.dbUrl.startsWith('file:')) problems.push('DATABASE_URL (a Turso libsql:// URL) is required in production; a local file would be lost on serverless hosting');
  if (prod && cfg.dbUrl.startsWith('libsql:') && !cfg.dbAuthToken) problems.push('DATABASE_AUTH_TOKEN is required with a Turso DATABASE_URL');
  if (!cfg.email.apiKey || !cfg.email.from) problems.push('BREVO_API_KEY (or RESEND_API_KEY) and EMAIL_FROM are required to send OTP emails');
  if (!cfg.upi.id && (!cfg.youpi.apiUrl || !cfg.youpi.webhookSecret)) {
    problems.push('Set UPI_ID (manual UPI payments) or YOUPI_API_URL and YOUPI_WEBHOOK_SECRET (automatic payments)');
  }
  if (!!cfg.google.clientId !== !!cfg.google.clientSecret) problems.push('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither');
  return problems;
}

// Problems that make the server unsafe or useless to start. Everything else (email, payments, Google) only disables that feature.
export function fatalProblems(cfg) {
  const prod = cfg.env === 'production';
  const p = [];
  if (cfg.sessionSecret.length < 32) p.push('SESSION_SECRET (at least 32 random characters)');
  if (prod && cfg.dbUrl.startsWith('file:')) p.push('DATABASE_URL (Turso libsql:// URL)');
  if (prod && cfg.dbUrl.startsWith('libsql:') && !cfg.dbAuthToken) p.push('DATABASE_AUTH_TOKEN');
  if (prod && !cfg.appUrl.startsWith('https://')) p.push('APP_URL (must be https://)');
  return p;
}
