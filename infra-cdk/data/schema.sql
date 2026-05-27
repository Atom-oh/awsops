-- ADR-030 Phase 1: Aurora schema for AWSops application state.
-- Idempotent — safe to re-apply. Each table mirrors a source listed in the
-- ADR migration table; JSONB `payload` holds the original document while
-- extracted columns enable indexes and similarity search.

BEGIN;

-- -------------------------------------------------------------------
-- schema_migrations: tracks applied versions so future migrations can
-- detect which steps already ran (Phase 1.5 onward).
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER     PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  description TEXT
);

-- -------------------------------------------------------------------
-- inventory_snapshots — replaces data/inventory/<account>/*.json
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_snapshots (
  id             BIGSERIAL    PRIMARY KEY,
  account_id     TEXT         NOT NULL,
  captured_at    TIMESTAMPTZ  NOT NULL,
  resource_type  TEXT         NOT NULL,
  resource_count INTEGER      NOT NULL DEFAULT 0,
  payload        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inventory_account_time
  ON inventory_snapshots (account_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_account_type_time
  ON inventory_snapshots (account_id, resource_type, captured_at DESC);

-- -------------------------------------------------------------------
-- cost_snapshots — replaces data/cost/<account>/*.json
-- One row per (account, period) — UPSERT on conflict.
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cost_snapshots (
  id           BIGSERIAL    PRIMARY KEY,
  account_id   TEXT         NOT NULL,
  period_start DATE         NOT NULL,
  period_end   DATE         NOT NULL,
  granularity  TEXT         NOT NULL DEFAULT 'DAILY',
  payload      JSONB        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_cost_snapshot UNIQUE (account_id, period_start, period_end, granularity)
);
CREATE INDEX IF NOT EXISTS idx_cost_account_period
  ON cost_snapshots (account_id, period_start DESC);

-- -------------------------------------------------------------------
-- agentcore_memory — replaces data/memory/<user>/*.json
-- Per-user conversation history with 365-day TTL (ADR-018).
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agentcore_memory (
  id              BIGSERIAL    PRIMARY KEY,
  user_sub        TEXT         NOT NULL,
  conversation_id TEXT         NOT NULL,
  turn_index      INTEGER      NOT NULL,
  role            TEXT         NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content         JSONB        NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '365 days'),
  CONSTRAINT uq_memory_turn UNIQUE (user_sub, conversation_id, turn_index)
);
CREATE INDEX IF NOT EXISTS idx_memory_user_created
  ON agentcore_memory (user_sub, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_conversation
  ON agentcore_memory (user_sub, conversation_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_memory_expires
  ON agentcore_memory (expires_at);

-- -------------------------------------------------------------------
-- agentcore_stats — replaces data/agentcore-stats.json
-- Append-only event log; daily/hourly rollups built via materialized views later.
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agentcore_stats (
  id            BIGSERIAL    PRIMARY KEY,
  occurred_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  event_type    TEXT         NOT NULL,
  gateway       TEXT,
  model         TEXT,
  user_sub      TEXT,
  duration_ms   INTEGER,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  payload       JSONB        NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_stats_time
  ON agentcore_stats (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_stats_user_time
  ON agentcore_stats (user_sub, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_stats_gateway_time
  ON agentcore_stats (gateway, occurred_at DESC);

-- -------------------------------------------------------------------
-- alert_diagnosis — replaces data/alert-diagnosis/*.json
-- One row per incident; payload holds full Bedrock analysis output.
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_diagnosis (
  id           BIGSERIAL    PRIMARY KEY,
  incident_id  TEXT         NOT NULL UNIQUE,
  occurred_at  TIMESTAMPTZ  NOT NULL,
  severity     TEXT         NOT NULL,
  source       TEXT         NOT NULL,
  services     TEXT[]       NOT NULL DEFAULT '{}',
  resources    TEXT[]       NOT NULL DEFAULT '{}',
  fingerprint  TEXT,
  payload      JSONB        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_diag_time
  ON alert_diagnosis (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_diag_severity_time
  ON alert_diagnosis (severity, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_diag_services
  ON alert_diagnosis USING GIN (services);
CREATE INDEX IF NOT EXISTS idx_diag_resources
  ON alert_diagnosis USING GIN (resources);
CREATE INDEX IF NOT EXISTS idx_diag_fingerprint
  ON alert_diagnosis (fingerprint) WHERE fingerprint IS NOT NULL;

-- -------------------------------------------------------------------
-- event_scaling_plans — replaces data/event-scaling/*.json (ADR-010)
-- -------------------------------------------------------------------
-- Status values must match src/lib/event-scaling.ts `EventStatus` exactly.
-- 상태 값은 src/lib/event-scaling.ts의 EventStatus와 정확히 일치해야 한다.
CREATE TABLE IF NOT EXISTS event_scaling_plans (
  id              BIGSERIAL    PRIMARY KEY,
  plan_id         TEXT         NOT NULL UNIQUE,
  event_name      TEXT         NOT NULL,
  event_start_at  TIMESTAMPTZ  NOT NULL,
  event_end_at    TIMESTAMPTZ,
  status          TEXT         NOT NULL
                              CHECK (status IN ('planned','analyzing','plan-ready','approved','cancelled')),
  owner_email     TEXT,
  payload         JSONB        NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scaling_status_time
  ON event_scaling_plans (status, event_start_at DESC);
CREATE INDEX IF NOT EXISTS idx_scaling_event_time
  ON event_scaling_plans (event_start_at DESC);

-- -------------------------------------------------------------------
-- report_schedules — replaces data/report-schedule.json
-- Singleton per (user, schedule_type).
-- -------------------------------------------------------------------
-- next_run_at is nullable to match writeSchedule() in src/lib/report-scheduler.ts:
-- when a schedule is disabled the next-run time is intentionally null.
-- next_run_at은 nullable — 스케줄이 disabled일 때 nextRunAt=null이 되는 코드 동작과 일치.
CREATE TABLE IF NOT EXISTS report_schedules (
  id            BIGSERIAL    PRIMARY KEY,
  user_sub      TEXT         NOT NULL,
  schedule_type TEXT         NOT NULL CHECK (schedule_type IN ('weekly','biweekly','monthly')),
  enabled       BOOLEAN      NOT NULL DEFAULT true,
  last_run_at   TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ,
  config        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_schedule UNIQUE (user_sub, schedule_type)
);
-- Defensive idempotent ALTER for any environment that already applied v1 schema
-- (PR #16 deployed report_schedules with next_run_at NOT NULL). Skips silently
-- when the column is already nullable.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'report_schedules'
      AND column_name = 'next_run_at'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE report_schedules ALTER COLUMN next_run_at DROP NOT NULL;
  END IF;
END;
$$;
-- `CREATE INDEX IF NOT EXISTS` only checks the index name, not its
-- definition. An environment that already applied v1 still has the older
-- partial index without `next_run_at IS NOT NULL`. Drop and re-create so
-- v2's stricter predicate takes effect.
-- v1을 적용한 환경에는 옛 partial index가 남아 있으므로 명시적 DROP 후 재생성.
DROP INDEX IF EXISTS idx_schedule_next_run;
CREATE INDEX idx_schedule_next_run
  ON report_schedules (next_run_at) WHERE enabled = true AND next_run_at IS NOT NULL;

-- -------------------------------------------------------------------
-- updated_at auto-touch trigger for tables that mutate in-place.
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cost_touch') THEN
    CREATE TRIGGER trg_cost_touch BEFORE UPDATE ON cost_snapshots
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_scaling_touch') THEN
    CREATE TRIGGER trg_scaling_touch BEFORE UPDATE ON event_scaling_plans
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_schedule_touch') THEN
    CREATE TRIGGER trg_schedule_touch BEFORE UPDATE ON report_schedules
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END;
$$;

INSERT INTO schema_migrations (version, description)
VALUES (1, 'ADR-030 Phase 1: initial 7-table app state schema')
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version, description)
VALUES (2, 'ADR-030 Phase 1 slice 2: report_schedules.next_run_at nullable')
ON CONFLICT (version) DO NOTHING;

COMMIT;
