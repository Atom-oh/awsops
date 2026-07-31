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
GRANT SELECT ON ALL TABLES IN SCHEMA public TO awsops_sql_reader;
-- Future migrations run as awsops_admin (the master user) — extend SELECT to whatever they create,
-- so this role doesn't need a follow-up migration per schema change. Deliberately SELECT only.
ALTER DEFAULT PRIVILEGES FOR ROLE awsops_admin IN SCHEMA public
  GRANT SELECT ON TABLES TO awsops_sql_reader;

-- Explicitly NOT granted: INSERT/UPDATE/DELETE/TRUNCATE, any sequence, CREATE on any schema, any
-- EXECUTE grant, membership in any predefined role (pg_read_server_files, pg_write_server_files,
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
-- hardening on top of the boundary, not the boundary. The boundary is NOSUPERUSER + zero EXECUTE
-- grants + SELECT-only + default_transaction_read_only, and it holds regardless of the outcome
-- here — a query_to_xml call from this role executes its inner SQL AS this role.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
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
  END LOOP;
END $$;
