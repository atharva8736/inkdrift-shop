-- Manual UPI mode: a bank reference (UTR) can be claimed by one order only.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_manual_utr ON payments(utr) WHERE utr IS NOT NULL AND provider = 'manual_upi';
