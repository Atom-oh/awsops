-- Gap-audit L178: a minimal, reusable key-value settings store — first consumer is the
-- diagnosis notification pause flag (key 'diagnosis_notify_paused'). An ABSENT key means
-- "not paused" (today's behavior; zero backfill). Deliberately NOT exposed to the agent
-- sql_reader views.
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
