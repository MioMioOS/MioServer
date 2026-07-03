-- Human presence: last time the user had a live WS subscription.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_seen_at" TIMESTAMPTZ;
