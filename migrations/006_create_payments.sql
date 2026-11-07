-- payments = ONE ROW PER PAYMENT ATTEMPT (one Razorpay order per attempt).
-- payment_transactions = append-only ledger of every gateway event/state change for an attempt.
-- No gateway credentials (key id/secret, webhook secret, signatures) are ever stored here.

CREATE TABLE IF NOT EXISTS payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  attempt_number      INTEGER NOT NULL CHECK (attempt_number > 0),
  gateway             VARCHAR(20) NOT NULL DEFAULT 'RAZORPAY',
  razorpay_order_id   VARCHAR(64) NOT NULL,     -- order_xxx
  razorpay_payment_id VARCHAR(64),              -- pay_xxx (the winning/latest gateway payment)
  status              VARCHAR(25) NOT NULL DEFAULT 'CREATED'
                      CHECK (status IN ('CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED',
                                        'FAILED', 'CANCELLED', 'EXPIRED',
                                        'PARTIALLY_REFUNDED', 'REFUNDED')),
  currency            CHAR(3) NOT NULL DEFAULT 'INR',
  amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  amount_refunded     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
  method              VARCHAR(30),              -- card, upi, netbanking, wallet ...
  failure_code        VARCHAR(100),
  failure_reason      TEXT,
  authorized_at       TIMESTAMPTZ,
  captured_at         TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_payments_order_attempt UNIQUE (order_id, attempt_number),
  CONSTRAINT uq_payments_razorpay_order UNIQUE (razorpay_order_id),
  CONSTRAINT payments_refund_chk CHECK (amount_refunded <= amount),
  CONSTRAINT payments_captured_chk CHECK (
    status NOT IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED')
    OR (razorpay_payment_id IS NOT NULL AND captured_at IS NOT NULL))
);

-- A gateway payment id maps to exactly one payment row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_razorpay_payment
  ON payments (razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;
-- DUPLICATE-PAYMENT GUARD 1: at most one successful payment per order.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_one_success_per_order
  ON payments (order_id) WHERE status IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED');
-- DUPLICATE-PAYMENT GUARD 2: at most one in-flight attempt per order (retry requires closing the old one).
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_one_open_per_order
  ON payments (order_id) WHERE status IN ('CREATED', 'PENDING', 'AUTHORIZED');
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id, attempt_number DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments (status, created_at);

DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Append-only history: attempts, authorizations, captures, failures, refunds.
CREATE TABLE IF NOT EXISTS payment_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id          UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  type                VARCHAR(20) NOT NULL
                      CHECK (type IN ('ATTEMPT', 'AUTHORIZATION', 'CAPTURE', 'FAILURE', 'REFUND')),
  status              VARCHAR(20) NOT NULL
                      CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
  amount              NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency            CHAR(3) NOT NULL DEFAULT 'INR',
  razorpay_payment_id VARCHAR(64),
  razorpay_refund_id  VARCHAR(64),
  -- Deterministic key per gateway fact, e.g. 'capture:pay_X', 'refund:rfnd_Y'.
  -- Replays of the same event (webhook retry + client verify call) hit this unique key.
  idempotency_key     VARCHAR(150) NOT NULL,
  source              VARCHAR(10) NOT NULL CHECK (source IN ('CLIENT', 'WEBHOOK', 'API', 'SYSTEM')),
  webhook_event_id    UUID,                      -- FK added in 007
  error_code          VARCHAR(100),
  error_description   TEXT,
  gateway_response    JSONB,                     -- sanitized payload; never credentials
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_payment_transactions_idem UNIQUE (idempotency_key),
  CONSTRAINT payment_transactions_refund_chk CHECK (type <> 'REFUND' OR razorpay_refund_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_transactions_refund
  ON payment_transactions (razorpay_refund_id) WHERE razorpay_refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_transactions_payment ON payment_transactions (payment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_rzp_payment
  ON payment_transactions (razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;

-- Enforce append-only (history must not be rewritten).
CREATE OR REPLACE FUNCTION prevent_payment_transaction_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'payment_transactions is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_transactions_immutable ON payment_transactions;
CREATE TRIGGER trg_payment_transactions_immutable
  BEFORE UPDATE OR DELETE ON payment_transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_payment_transaction_mutation();
