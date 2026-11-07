-- Phase 4: lets a webhook delivery "claim" an event. A PROCESSING event whose lease is older than a few
-- minutes (worker crashed mid-way) can be re-claimed by Razorpay's next retry.
ALTER TABLE payment_webhook_events ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
