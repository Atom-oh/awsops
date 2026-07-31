-- since: 2.0.0
-- Dedicated least-privilege Postgres role for the agent `execute_sql` MCP tool (aws_rds_mcp.py) and
-- the inventory-read connector (inventory_read_mcp.py) — replaces running those RDS Data API calls
-- under the Aurora MASTER secret (a superuser-equivalent role).
--
-- WHY (PR #197 rounds 3-7): execute_sql's read-only guarantee rested on two things that are not
-- boundaries. (1) A lexical denylist in sql_readonly_guard.py — it strips string literals BEFORE
-- matching, so any core function that takes SQL as a *string argument* is invisible to it:
--   SELECT query_to_xml('SELECT pg_cancel_backend(pid) FROM pg_stat_activity', true, false, '')
-- is a first-token SELECT with no DANGER token, and query_to_xml is core PostgreSQL (no extension).
-- (2) `SET TRANSACTION READ ONLY` — which only blocks data WRITES; control-plane and side-effect
-- functions (pg_cancel_backend, pg_reload_conf, set_config, aws_lambda.invoke, ...) are explicitly
-- permitted inside a read-only transaction. Seven rounds of review each found a new way through the
-- text filter, because "functions that execute a string" is an unbounded set.
--
-- So the boundary moves into the DATABASE: the tool now authenticates as this role, and the agent
-- Lambda IAM role no longer has GetSecretValue on the Aurora master secret at all (ai.tf). The
-- lexical guard and the READ ONLY transaction both stay in place — cheap, and they catch honest
-- mistakes early — but they are defense-in-depth, not the boundary.
--
-- Unlike awsops_web / awsops_worker / steampipe_reader (all rds_iam, no password), this role needs a
-- password: the RDS Data API REQUIRES a Secrets Manager `secretArn` on every ExecuteStatement /
-- BeginTransaction / RollbackTransaction call (see botocore's rds-data model — secretArn is a
-- required member) and sends that username/password to the engine. IAM database auth is therefore
-- not reachable on this path. The password is generated and owned by Terraform
-- (random_password.agent_sql_reader -> aws_secretsmanager_secret.agent_sql_reader in ai.tf) and
-- pushed into this role by `make migrate` (scripts/v2/migrate.mjs), so the secret stays the single
-- source of truth and a Terraform-side rotation re-syncs on the next migrate.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'awsops_sql_reader') THEN
    CREATE ROLE awsops_sql_reader WITH LOGIN;
  END IF;
END $$;

-- Idempotent + explicit: state every attribute rather than relying on CREATE ROLE defaults, so
-- re-running against a pre-existing role converges to the same least-privilege shape.
ALTER ROLE awsops_sql_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  NOREPLICATION NOBYPASSRLS;

-- Session-level read-only for this principal specifically: every connection starts read-only even
-- if a future code path forgets the explicit `SET TRANSACTION READ ONLY` wrapper.
ALTER ROLE awsops_sql_reader SET default_transaction_read_only = on;
-- Deny the role the ability to turn that back off, or to reach anything outside `public`/pg_catalog
-- by search_path games. (search_path is not a privilege, but pinning it keeps a shadowed function
-- in a user-writable schema from being resolved ahead of a catalog one.)
ALTER ROLE awsops_sql_reader SET search_path = public, pg_catalog;

GRANT CONNECT ON DATABASE awsops TO awsops_sql_reader;
GRANT USAGE ON SCHEMA public TO awsops_sql_reader;

-- ── INVARIANT (read this before adding a table to the list below) ─────────────────────────────────
-- `execute_sql` is a MODEL-INVOCABLE tool: whatever this role can SELECT, the agent can be talked
-- into printing. So this role must NEVER be granted access to a credential-bearing column. A future
-- migration that adds a secret/token/password/bearer column MUST also verify this grant list (and
-- prefer a column-level grant or a redacted view over a whole-table grant).
--
-- PR-review round 9 CRITICAL: this migration originally did
--   GRANT SELECT ON ALL TABLES IN SCHEMA public + ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES
-- which handed the agent `eks_registrations.auth` — a JSONB holding a raw Kubernetes ServiceAccount
-- bearer token that the read APIs deliberately return as `mode` only (see the
-- `eks_registrations_auth` migration, line 7). A PR that set out to STRENGTHEN the read-only boundary
-- would have shipped a new credential-exfiltration path. The blanket ALTER DEFAULT PRIVILEGES was the
-- worse half: it silently extends SELECT to every table any FUTURE migration adds, so the next person
-- to store a secret in a new table re-opens the hole with no review signal at all. Both are gone —
-- the grant is now an explicit allowlist, so a new table is invisible to this role until someone
-- deliberately adds it here.
--
-- Also REVOKEd first, so a cluster where the earlier blanket-grant version of this file already ran
-- converges to the allowlist instead of keeping the wide grant.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM awsops_sql_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE awsops_admin IN SCHEMA public
  REVOKE SELECT ON TABLES FROM awsops_sql_reader;

-- Allowlist: the inventory/diagnostic tables the two consumers of this role actually read.
--   * inventory-read connector (agent/lambda/inventory_read_mcp.py): inventory_resources,
--     inventory_sync_runs, topology_nodes, topology_edges.
--   * rds-mcp `execute_sql`: ad-hoc Aurora diagnostics over the same operational state.
-- Existence-guarded per table (RAISE NOTICE, not abort) so the migration still runs against a DB
-- that predates one of them.
--
-- DELIBERATELY EXCLUDED (do not add without re-reading the invariant above):
--   * eks_registrations  — `auth` JSONB holds a plaintext k8s bearer token. Column-level grant below
--                          mirrors the app's redaction boundary at the DB level instead.
--   * accounts           — `external_id` is documented as a confused-deputy guard rather than a
--                          secret, but it is still an AssumeRole input; column-level grant below.
--   * integrations       — the credential registry (credentials_ref / inbound_auth_ref /
--                          private_connection_ref). Those are Secrets Manager ARNs, not plaintext,
--                          but no consumer of this role needs the table, so it stays out.
--   * chat_threads / chat_messages / agentcore_memory — cross-user conversation content (users do
--                          paste credentials into chat). No consumer needs them.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    -- inventory / topology (the inventory-read connector's own queries)
    'inventory_resources', 'inventory_snapshots', 'inventory_sync_runs',
    'topology_nodes', 'topology_edges',
    -- jobs, diagnosis, compliance
    'worker_jobs', 'schema_migrations', 'diagnosis_reports', 'alert_diagnosis',
    'compliance_runs', 'compliance_results',
    -- incident lifecycle
    'incidents', 'incident_findings', 'incident_stages', 'incident_links', 'incident_writeback',
    -- prevention / insights / AI accounting
    'prevention_insights', 'prevention_recommendations',
    'ai_insights', 'ai_usage_daily', 'ai_token_budget', 'agentcore_stats',
    -- cost
    'cost_snapshots', 'opencost_config',
    -- architecture / datasource metadata (no secrets: schema caches and query templates)
    'architecture_intent', 'datasource_schemas', 'datasource_diag_signals',
    'datasource_graph_queries',
    -- account scoping (accounts itself is column-level below)
    'account_regions',
    -- actions / audit / scheduling
    'action_catalog', 'action_plans', 'event_scaling_plans',
    'remediation_audit', 'customization_audit', 'report_schedules',
    -- agent platform config (personas/routing, no credentials)
    'agents', 'agent_spaces', 'agent_skills', 'skills'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = t) THEN
      EXECUTE format('GRANT SELECT ON public.%I TO awsops_sql_reader', t);
    ELSE
      RAISE NOTICE 'awsops_sql_reader: table public.% not present — grant skipped', t;
    END IF;
  END LOOP;
END $$;

-- Column-level grants: same tables the app exposes, minus the sensitive column. This is the DB-level
-- mirror of the application's redaction boundary — `SELECT auth FROM eks_registrations` and
-- `SELECT external_id FROM accounts` both fail for this role, while everything the agent legitimately
-- needs (which clusters/accounts exist, their status) still works. Note the consequence:
-- `SELECT * FROM eks_registrations` is DENIED for this role (the star expands to include `auth`) —
-- name the columns. Verified on postgres:17-alpine: cluster_name OK, `auth` and `*` denied,
-- `accounts.external_id` denied, a newly created table denied (no blanket/default grant), and
-- INSERT rejected by default_transaction_read_only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'eks_registrations') THEN
    -- every column EXCEPT auth (the k8s bearer token)
    GRANT SELECT (cluster_name, registered_by, created_at) ON eks_registrations TO awsops_sql_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'accounts') THEN
    -- every column EXCEPT external_id
    GRANT SELECT (account_id, alias, region, is_host, role_name, enabled, status,
                  last_verified_at, created_at, all_regions) ON accounts TO awsops_sql_reader;
  END IF;
END $$;

-- Explicitly NOT granted: INSERT/UPDATE/DELETE/TRUNCATE, any sequence, CREATE on any schema, any
-- EXECUTE grant to this role, membership in any predefined role (pg_read_server_files, pg_write_server_files,
-- pg_execute_server_program, pg_signal_backend, rds_superuser, aws_lambda, aws_s3). NOINHERIT means
-- even a future accidental group grant does not take effect without an explicit SET ROLE.

-- ── Best-effort belt-and-braces: revoke PUBLIC EXECUTE on the side-effect function classes ────────
-- Which of these actually need this, for a plain NOSUPERUSER role:
--   * ALREADY DENIED by PostgreSQL itself (EXECUTE revoked from PUBLIC out of the box; usable only
--     by superusers or members of a predefined role this role is not in):
--     pg_read_file, pg_read_binary_file, pg_stat_file, pg_ls_dir (+ pg_ls_*dir), server-side
--     lo_import/lo_export, pg_reload_conf, pg_rotate_logfile, pg_switch_wal, pg_stat_reset*,
--     pg_create_*_replication_slot / pg_drop_replication_slot (also NOREPLICATION here),
--     aws_lambda.invoke / aws_s3.query_export_to_s3 (extension functions are not PUBLIC-executable
--     and neither extension is installed on this cluster).
--   * PUBLIC-EXECUTABLE and therefore genuinely reachable — these are the ones worth revoking:
--     query_to_xml / query_to_xmlschema / table_to_xml* / schema_to_xml* / database_to_xml* /
--     cursor_to_xml (the round-7 vector: SQL-as-a-string), pg_cancel_backend / pg_terminate_backend
--     (PostgreSQL additionally limits these to backends owned by the SAME role unless the caller is
--     in pg_signal_backend — so this role could only ever signal its own sessions, never the web or
--     worker roles' — but revoking removes even that), lo_create / lo_put / lo_unlink /
--     lo_from_bytea (large-object writes; also blocked by the read-only transaction), pg_sleep*
--     (no data access, but a free connection-holding DoS), dblink* (only if the extension is ever
--     installed — it is not today).
-- On Amazon RDS/Aurora the pg_catalog functions are owned by `rdsadmin`, and the master user
-- (awsops_admin, a member of rds_superuser) is NOT a member of that role — so these REVOKEs may
-- fail with insufficient_privilege. That is tolerated per-function (NOTICE, not abort): they are
-- hardening on top of the boundary, not the boundary.
-- PR-review round 9 MAJOR — do NOT read these REVOKEs as a guarantee that PUBLIC EXECUTE is gone.
-- They are best-effort and may all be skipped. The boundary is the ROLE: NOSUPERUSER, no table-write
-- privilege, SELECT on an explicit allowlist only, no predefined-role membership,
-- default_transaction_read_only=on. That argument holds whether or not a single REVOKE lands:
-- `query_to_xml(...)` invoked BY this role executes its inner SQL AS this role, so it can only reach
-- what this role can already reach, and `pg_cancel_backend` is limited by PostgreSQL to backends
-- owned by the same role (this role is not in pg_signal_backend), so it can only signal its own
-- sessions — never the web or worker roles'.
-- Making the revoke failures fatal is deliberately NOT done: on Aurora that would likely make this
-- migration unrunnable. Instead the post-state is reported below so an operator can see the truth.
DO $$
DECLARE
  f record;
  still_public text[] := ARRAY[]::text[];
BEGIN
  FOR f IN
    SELECT p.oid, p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('pg_catalog', 'public')
      AND (
        p.proname IN ('query_to_xml', 'query_to_xmlschema', 'query_to_xml_and_xmlschema',
                      'pg_cancel_backend', 'pg_terminate_backend',
                      'lo_create', 'lo_put', 'lo_unlink', 'lo_from_bytea',
                      'pg_sleep', 'pg_sleep_for', 'pg_sleep_until')
        OR p.proname LIKE 'table_to_xml%'
        OR p.proname LIKE 'schema_to_xml%'
        OR p.proname LIKE 'database_to_xml%'
        OR p.proname LIKE 'cursor_to_xml%'
        OR p.proname LIKE 'dblink%'
      )
  LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.sig);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'could not revoke PUBLIC EXECUTE on % (%) — hardening skipped, boundary is the role itself', f.sig, SQLERRM;
    END;
    -- Report the ACTUAL post-state, so "no PUBLIC EXECUTE" is never assumed from a silent run.
    IF has_function_privilege('public', f.oid, 'EXECUTE') THEN
      still_public := still_public || f.sig::text;
    END IF;
  END LOOP;
  IF array_length(still_public, 1) IS NULL THEN
    RAISE NOTICE 'awsops_sql_reader hardening: PUBLIC EXECUTE revoked on all targeted functions';
  ELSE
    RAISE NOTICE 'awsops_sql_reader hardening: % targeted function(s) STILL have PUBLIC EXECUTE (expected on RDS/Aurora — boundary is the role, not this revoke): %',
      array_length(still_public, 1), array_to_string(still_public, ', ');
  END IF;
END $$;
