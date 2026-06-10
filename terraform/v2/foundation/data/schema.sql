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
CREATE TABLE IF NOT EXISTS report_schedules (
  id            BIGSERIAL    PRIMARY KEY,
  user_sub      TEXT         NOT NULL,
  schedule_type TEXT         NOT NULL CHECK (schedule_type IN ('weekly','biweekly','monthly')),
  enabled       BOOLEAN      NOT NULL DEFAULT true,
  last_run_at   TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ  NOT NULL,
  config        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_schedule UNIQUE (user_sub, schedule_type)
);
CREATE INDEX IF NOT EXISTS idx_schedule_next_run
  ON report_schedules (next_run_at) WHERE enabled = true;

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

COMMIT;

-- P2: async worker backbone job ledger (infra table; orthogonal to ADR-030 7 app-state tables)
CREATE TABLE IF NOT EXISTS worker_jobs (
  job_id            UUID PRIMARY KEY,
  type              TEXT NOT NULL,
  runtime           TEXT,                          -- 'lambda' | 'fargate' (set by SFN/worker)
  status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  result            JSONB,                          -- small inline result
  artifact_uri      TEXT,                           -- large result: s3://bucket/key
  error             TEXT,
  dry_run           BOOLEAN NOT NULL DEFAULT false,
  idempotency_key   TEXT UNIQUE,                    -- enqueue dedup (NULL allowed)
  attempt           INTEGER NOT NULL DEFAULT 0,
  sfn_execution_arn TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_worker_jobs_status ON worker_jobs(status);
CREATE INDEX IF NOT EXISTS idx_worker_jobs_status_updated ON worker_jobs(status, updated_at);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_worker_jobs_touch') THEN
    CREATE TRIGGER trg_worker_jobs_touch BEFORE UPDATE ON worker_jobs
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;

-- D1 inventory: per-resource rows (NOT a JSONB blob-per-type — server-side paginate/filter).
CREATE TABLE IF NOT EXISTS inventory_resources (
  resource_type TEXT        NOT NULL,
  account_id    TEXT        NOT NULL DEFAULT 'self',
  region        TEXT        NOT NULL DEFAULT '',
  resource_id   TEXT        NOT NULL,
  data          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_type, account_id, region, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_type ON inventory_resources(resource_type, account_id);

-- sync run status (freshness + error surface; one row per (type,account)).
CREATE TABLE IF NOT EXISTS inventory_sync_runs (
  resource_type TEXT        NOT NULL,
  account_id    TEXT        NOT NULL DEFAULT 'self',
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT        NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','succeeded','failed')),
  row_count     INTEGER,
  error         TEXT,
  PRIMARY KEY (resource_type, account_id)
);

-- ============================================================================
-- ADR-031 Phase 1: runtime-customizable agents & skills catalog
-- (idempotent; admin-only authoring; disabled-by-default for custom rows)
-- ============================================================================
CREATE TABLE IF NOT EXISTS skills (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  description    TEXT NOT NULL,
  instructions   TEXT NOT NULL DEFAULT '',
  tool_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb,
  tier           TEXT NOT NULL CHECK (tier IN ('builtin','custom')),
  content_hash   TEXT NOT NULL,
  version        INT  NOT NULL DEFAULT 1,
  enabled        BOOLEAN NOT NULL DEFAULT false,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  description      TEXT NOT NULL,
  persona          TEXT NOT NULL DEFAULT '',
  routing_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  gateway          TEXT NOT NULL,
  model            TEXT,
  tier             TEXT NOT NULL CHECK (tier IN ('builtin','custom')),
  version          INT  NOT NULL DEFAULT 1,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id BIGINT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  ord      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, skill_id)
);

CREATE TABLE IF NOT EXISTS customization_audit (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,        -- upsert|enable|disable|attach|delete
  object_type TEXT NOT NULL,        -- skill|agent|agent_skill
  object_id   TEXT NOT NULL,
  before_hash TEXT,
  after_hash  TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_enabled ON agents (enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills (enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_audit_at ON customization_audit (at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_skills_touch') THEN
    CREATE TRIGGER trg_skills_touch BEFORE UPDATE ON skills
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_agents_touch') THEN
    CREATE TRIGGER trg_agents_touch BEFORE UPDATE ON agents
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;

-- Seed the 8 built-in gateways as read-only catalog rows (enabled, no persona --
-- their prompt is served by agent.py SKILL_BASE; resolver returns no override).
INSERT INTO agents (name, description, persona, routing_keywords, gateway, tier, enabled)
SELECT v.name, v.description, '', '[]'::jsonb, v.gateway, 'builtin', true
FROM (VALUES
  ('network','Built-in: VPC/TGW/VPN/ENI/Flow Logs','network'),
  ('container','Built-in: EKS/ECS/Istio','container'),
  ('iac','Built-in: CloudFormation/CDK/Terraform','iac'),
  ('data','Built-in: DynamoDB/RDS/ElastiCache/MSK','data'),
  ('security','Built-in: IAM/policy simulation','security'),
  ('monitoring','Built-in: CloudWatch/CloudTrail','monitoring'),
  ('cost','Built-in: Cost Explorer/Budgets/FinOps','cost'),
  ('ops','Built-in: AWS docs/CLI/Steampipe','ops')
) AS v(name, description, gateway)
ON CONFLICT (name) DO NOTHING;

INSERT INTO schema_migrations (version, description)
VALUES (2, 'ADR-031 Phase 1: agents/skills catalog + built-in seed')
ON CONFLICT (version) DO NOTHING;

-- ADR-033 Phase 2: durable per-(account,user,day) AI token budget.
-- Source of truth for the daily token cap; the app keeps an in-process Map as a
-- fast-path cache seeded from this table on cold start (see token-budget.ts).
CREATE TABLE IF NOT EXISTS ai_token_budget (
  account_id    TEXT        NOT NULL,
  user_sub      TEXT        NOT NULL,
  day           DATE        NOT NULL,
  input_tokens  BIGINT      NOT NULL DEFAULT 0,
  output_tokens BIGINT      NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_sub, day)
);

INSERT INTO schema_migrations (version, description)
VALUES (3, 'ADR-033 Phase 2: durable AI token budget table')
ON CONFLICT (version) DO NOTHING;

-- ============================================================================
-- ADR-029+036 (migration v4): remediation/mutation substrate — catalog + plans + audit.
-- ALWAYS PRESENT (data only; zero infra, zero execution). Every catalog row ships
-- enabled=false; no action is executable until remediation_enabled + the kill-switch
-- + the row's enabled flag are all true AND a 4-eyes approval passes. Idempotent.
-- ============================================================================

-- 1) The typed Action Catalog — the single facade (ADR-029 control #1, ADR-036 rule #2).
CREATE TABLE IF NOT EXISTS action_catalog (
  name                TEXT PRIMARY KEY,
  description         TEXT NOT NULL DEFAULT '',
  executor_type       TEXT NOT NULL CHECK (executor_type IN ('ssm','lambda','fargate')),
  target_resource_type TEXT NOT NULL,                     -- e.g. 'ec2:instance', 'k8s:scaledobject'
  iam_actions         JSONB NOT NULL DEFAULT '[]'::jsonb, -- per-action IAM decomposition (doc only; real IAM is in TF)
  assume_role_ref     TEXT,                               -- SSM: AutomationAssumeRole logical name; lambda/fargate: task-role logical name
  required_inputs     JSONB NOT NULL DEFAULT '[]'::jsonb, -- e.g. ["resourceArn","tags"]
  dry_run_contract    JSONB NOT NULL DEFAULT '{}'::jsonb, -- {"mode":"native|describe|check","describe":"..."} (ADR-029 #3 / ADR-036 #2)
  rollback_ref        TEXT,                               -- runbook onFailure step name OR executor rollback fn id
  approval_mode       TEXT NOT NULL DEFAULT 'four_eyes'
                        CHECK (approval_mode IN ('four_eyes','change_manager')),
  conditions          JSONB NOT NULL DEFAULT '{}'::jsonb, -- {"accounts":["self"],"regions":["ap-northeast-2"],"resourceArns":[...]}
  enabled             BOOLEAN NOT NULL DEFAULT false,      -- HARD OFF by default
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) Action plans — the two-step plan→execute artifact (ADR-029 control #2).
CREATE TABLE IF NOT EXISTS action_plans (
  plan_id            UUID PRIMARY KEY,
  action_name        TEXT NOT NULL REFERENCES action_catalog(name) ON DELETE RESTRICT,
  idempotency_token  TEXT NOT NULL UNIQUE,                -- replay-safe; 5-min expiry below
  inputs             JSONB NOT NULL DEFAULT '{}'::jsonb,
  dry_run            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- the dry-run result captured at plan time
  rollback_plan      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- paired, separately-validated rollback (ADR-029 #5)
  status             TEXT NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned','approved','executing','succeeded','failed','canceled','expired')),
  created_by         TEXT NOT NULL,                        -- authenticated principal (admin email/sub)
  approved_by        TEXT,                                 -- MUST differ from created_by (4-eyes)
  job_id             UUID,                                 -- the worker_jobs row enqueued at execute time
  expires_at         TIMESTAMPTZ NOT NULL,                 -- created_at + 5 min
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_action_plans_status ON action_plans (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_action_plans_action ON action_plans (action_name, created_at DESC);

-- 3) Synchronous authenticated-principal audit sink (ADR-029 control #6; the S3 Object-Lock
--    bucket is the second synchronous sink, CloudTrail is defense-in-depth, NOT a sync gate).
CREATE TABLE IF NOT EXISTS remediation_audit (
  id            BIGSERIAL PRIMARY KEY,
  plan_id       UUID,
  job_id        UUID,
  action_name   TEXT,
  phase         TEXT NOT NULL,        -- plan|approve|execute|dry_run|rollback|terminal
  principal     TEXT NOT NULL,        -- authenticated email/sub (NOT "the task role")
  decision      TEXT,                 -- approved|denied|expired|killswitch_blocked|flag_off
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rem_audit_plan ON remediation_audit (plan_id, at);
CREATE INDEX IF NOT EXISTS idx_rem_audit_at   ON remediation_audit (at DESC);

-- 4) Extend worker_jobs for the remediation lifecycle WITHOUT renaming anything (additive).
--    Widen the status CHECK to add awaiting_approval + manual_intervention.
ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS automation_execution_id TEXT; -- SSM AutomationExecutionId
ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS task_token             TEXT;  -- SFN .waitForTaskToken token (ssm branch)
ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS plan_id                UUID;  -- link back to action_plans
DO $$ BEGIN
  ALTER TABLE worker_jobs DROP CONSTRAINT IF EXISTS worker_jobs_status_check;
  ALTER TABLE worker_jobs ADD CONSTRAINT worker_jobs_status_check
    CHECK (status IN ('queued','running','awaiting_approval','manual_intervention',
                      'succeeded','failed','canceled'));
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_action_catalog_touch') THEN
    CREATE TRIGGER trg_action_catalog_touch BEFORE UPDATE ON action_catalog
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_action_plans_touch') THEN
    CREATE TRIGGER trg_action_plans_touch BEFORE UPDATE ON action_plans
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;

-- 5) Seed 2-3 EXAMPLE action definitions — ALL enabled=false, ALL approval-required.
--    These are DEFINITIONS only; nothing runs until enabled + flag + kill-switch + approval.
INSERT INTO action_catalog
  (name, description, executor_type, target_resource_type, iam_actions, assume_role_ref,
   required_inputs, dry_run_contract, rollback_ref, approval_mode, conditions, enabled)
VALUES
  -- (a) AWS-resource action via SSM Automation + Change Manager (the canonical Modify* case).
  ('ec2-create-tags',
   'Add tags to a specific EC2 instance via an SSM Automation runbook (Change-Manager 4-eyes).',
   'ssm', 'ec2:instance',
   '["ec2:CreateTags","ec2:DeleteTags","ec2:DescribeTags"]'::jsonb,
   'ec2-create-tags',                                  -- AutomationAssumeRole logical name (remediation.tf)
   '["resourceArn","tags"]'::jsonb,
   '{"mode":"describe","describe":"ec2:DescribeTags"}'::jsonb,
   'RollbackDeleteTags',                               -- runbook onFailure step name
   'change_manager',
   '{"accounts":["self"],"regions":["ap-northeast-2"],"resourceArnAllowlist":[]}'::jsonb,
   false),
  -- (b) App-state action via the P2 lambda code executor (per-action task role).
  ('app-feature-flag-set',
   'Set an application feature flag row in Aurora (app-state mutation; P2 lambda executor).',
   'lambda', 'app:feature_flag',
   '[]'::jsonb,
   'app-feature-flag',                                 -- per-action task-role logical name (remediation.tf)
   '["flagKey","value"]'::jsonb,
   '{"mode":"check"}'::jsonb,
   'rollback_feature_flag',                            -- remediation_executor.py rollback fn id
   'four_eyes',
   '{"accounts":["self"]}'::jsonb,
   false),
  -- (c) Observability-write via the P2 lambda executor with the reduced control subset (ADR-036 #5).
  ('opscenter-create-opsitem',
   'Create an OpsCenter OpsItem (low-risk observability write; reduced control subset, no SSM runbook).',
   'lambda', 'ssm:opsitem',
   '["ssm:CreateOpsItem"]'::jsonb,
   'opscenter-write',
   '["title","source","severity"]'::jsonb,
   '{"mode":"check"}'::jsonb,
   NULL,                                               -- create is non-destructive; rollback = resolve (manual)
   'four_eyes',
   '{"accounts":["self"]}'::jsonb,
   false)
ON CONFLICT (name) DO NOTHING;

INSERT INTO schema_migrations (version, description)
VALUES (4, 'ADR-029+036: remediation substrate — action_catalog + action_plans + remediation_audit + worker_jobs cols (all disabled)')
ON CONFLICT (version) DO NOTHING;

-- ============================================================================
-- ADR-032 (migration v5): incident lifecycle DOMAIN STATE — always-present,
-- inert when incident_lifecycle_enabled=false. Extends (does NOT replace)
-- alert_diagnosis. NO autonomous behavior; orchestration rides the P2 backbone.
-- ============================================================================

-- 1) incidents — one durable row per correlated incident (the lifecycle aggregate).
--    correlation_key is the dedup-race UNIQUE key (Addendum (a)): concurrent
--    alerts that both pass the look-back must NOT both create a 'New'.
CREATE TABLE IF NOT EXISTS incidents (
  id               UUID PRIMARY KEY,
  correlation_key  TEXT NOT NULL UNIQUE,                 -- dedup-race winner; rest resolve to Linked
  fingerprint      TEXT,                                 -- carried from alert_diagnosis correlation
  status           TEXT NOT NULL DEFAULT 'triaged'
                     CHECK (status IN ('triaged','investigating','root_cause',
                            'mitigation_planned','prevention','resolved','stalled','skipped')),
  severity         TEXT NOT NULL DEFAULT 'warning',
  trigger_source   TEXT NOT NULL,                        -- cloudwatch|alertmanager|grafana|generic|manual
  services         TEXT[] NOT NULL DEFAULT '{}',
  resources        TEXT[] NOT NULL DEFAULT '{}',
  agent_space_version TEXT,                              -- ADR-031 traceability
  rca              JSONB,                                -- ADR-034 seam (persist locally; 034 writes back later)
  mitigation_plan  JSONB,                                -- recommendation-only catalog action refs (NEVER executed here)
  embedding_seam   JSONB,                                -- pgvector future-landing seam (deferred; see plan)
  first_event_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_event_at    TIMESTAMPTZ NOT NULL DEFAULT now(),   -- look-back window anchor
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incidents_active
  ON incidents (status, last_event_at) WHERE status IN ('triaged','investigating');
CREATE INDEX IF NOT EXISTS idx_incidents_services ON incidents USING GIN (services);
CREATE INDEX IF NOT EXISTS idx_incidents_resources ON incidents USING GIN (resources);

-- 2) incident_stages — per-stage checkpoint + idempotency (Addendum (b)+(c)).
--    stage_idempotency_key UNIQUE per (incident, stage) so a retried Investigation
--    resumes from the last checkpoint and never spawns duplicate Sub-agents.
CREATE TABLE IF NOT EXISTS incident_stages (
  id                   BIGSERIAL PRIMARY KEY,
  incident_id          UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  stage                TEXT NOT NULL
                         CHECK (stage IN ('triage','investigation','root_cause',
                                'mitigation_plan','prevention')),
  stage_idempotency_key TEXT NOT NULL,
  job_id               UUID,                             -- the worker_jobs orchestration row (P2 accounting)
  status               TEXT NOT NULL DEFAULT 'running'
                         CHECK (status IN ('running','succeeded','failed','stalled')),
  last_checkpoint_at   TIMESTAMPTZ NOT NULL DEFAULT now(),  -- watchdog anchor (Addendum (b))
  timeout_seconds      INTEGER,                          -- snapshot of the configurable stage timeout
  detail               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (incident_id, stage_idempotency_key)            -- stage-level idempotency (Addendum (c))
);
CREATE INDEX IF NOT EXISTS idx_incident_stages_watch
  ON incident_stages (status, last_checkpoint_at) WHERE status = 'running';

-- 3) incident_findings — compressed Sub-agent findings (Phase 2 fan-out).
CREATE TABLE IF NOT EXISTS incident_findings (
  id           BIGSERIAL PRIMARY KEY,
  incident_id  UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  sub_agent    TEXT NOT NULL,                            -- gateway/agent name (ADR-031)
  agent_version INT,
  skill_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,       -- ADR-031 traceability
  findings     JSONB NOT NULL DEFAULT '{}'::jsonb,       -- compacted
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_findings_incident ON incident_findings (incident_id);

-- 4) incident_links — the 'Linked' alerts that lost the dedup race (Addendum (a)).
CREATE TABLE IF NOT EXISTS incident_links (
  id            BIGSERIAL PRIMARY KEY,
  incident_id   UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  correlation_key TEXT NOT NULL,                         -- the losing alert's would-be key
  reason        TEXT NOT NULL DEFAULT '',
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_links_incident ON incident_links (incident_id);

-- 5) prevention_recommendations — Phase-4 skeleton output.
CREATE TABLE IF NOT EXISTS prevention_recommendations (
  id           BIGSERIAL PRIMARY KEY,
  incident_id  UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,                            -- observability|testing|code|infra
  recommendation TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_incidents_touch') THEN
    CREATE TRIGGER trg_incidents_touch BEFORE UPDATE ON incidents
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;

INSERT INTO schema_migrations (version, description)
VALUES (5, 'ADR-032: incident lifecycle domain — incidents + incident_stages (checkpoint/idempotency) + findings + links + prevention (inert when off)')
ON CONFLICT (version) DO NOTHING;
