-- Raw inbox of Razorpay webhooks. Insert FIRST (dedupe by event id), then process.
-- Stores the payload for audit/replay; the webhook secret and X-Razorpay-Signature are NOT stored
-- (only the boolean result of verification).
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway            VARCHAR(20) NOT NULL DEFAULT 'RAZORPAY',
  gateway_event_id   VARCHAR(100) NOT NULL,      -- X-Razorpay-Event-Id header
  event_type         VARCHAR(60) NOT NULL,       -- payment.captured, refund.processed ...
  razorpay_order_id  VARCHAR(64),
  razorpay_payment_id VARCHAR(64),
  razorpay_refund_id VARCHAR(64),
  payment_id         UUID REFERENCES payments(id) ON DELETE SET NULL,
  signature_verified BOOLEAN NOT NULL,
  payload            JSONB NOT NULL,
  processing_status  VARCHAR(15) NOT NULL DEFAULT 'RECEIVED'
                     CHECK (processing_status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED')),
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error         TEXT,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at       TIMESTAMPTZ,
  CONSTRAINT uq_webhook_events_gateway_event UNIQUE (gateway, gateway_event_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_pending
  ON payment_webhook_events (received_at) WHERE processing_status IN ('RECEIVED', 'FAILED');
CREATE INDEX IF NOT EXISTS idx_webhook_events_rzp_order ON payment_webhook_events (razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_rzp_payment ON payment_webhook_events (razorpay_payment_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_payment ON payment_webhook_events (payment_id);

ALTER TABLE payment_transactions
  ADD CONSTRAINT fk_payment_transactions_webhook_event
  FOREIGN KEY (webhook_event_id) REFERENCES payment_webhook_events(id) ON DELETE SET NULL;
