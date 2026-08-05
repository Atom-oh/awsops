-- since: 2.1.0
-- Follow-up to agent_sql_reader_role (01KYVY9J2E8AMF35WR4J7036A3): that migration's ALTER ROLE
-- deliberately does NOT restate SUPERUSER/REPLICATION/BYPASSRLS on awsops_sql_reader, because
-- PostgreSQL requires the CALLER to itself hold one of those three attributes to set or clear it
-- on another role (only a true superuser is exempt), and the Aurora master user (awsops_admin, a
-- member of rds_superuser but not a real superuser) holds none of them — restating any of the
-- three there failed with "permission denied to alter role" on this project's live cluster.
--
-- That omission is safe for the ordinary path: a role CREATEd fresh gets NOSUPERUSER/
-- NOREPLICATION/NOBYPASSRLS from CREATE ROLE's own defaults, which the omission never touches.
-- What it CANNOT do is CONVERGE a pre-existing awsops_sql_reader that somehow already has one of
-- the three set (manual grant, drift, a future bug) back down — and the master user cannot fix
-- that via ALTER ROLE either. Silently proceeding in that case would run this schema's read-only
-- MCP tools (execute_sql / inventory-read) against a role that is not actually confined to the
-- sql_reader views, defeating the whole point of PR #197. So: fail loud, not silently pass.
DO $$
DECLARE
  r record;
BEGIN
  SELECT rolsuper, rolreplication, rolbypassrls INTO r
    FROM pg_roles WHERE rolname = 'awsops_sql_reader';
  IF NOT FOUND THEN
    RETURN; -- role not created yet (agentcore_enabled=false) — nothing to guard.
  END IF;
  IF r.rolsuper OR r.rolreplication OR r.rolbypassrls THEN
    RAISE EXCEPTION 'awsops_sql_reader has an elevated attribute this project''s migrations cannot '
      'revoke (rolsuper=%, rolreplication=%, rolbypassrls=%) — the Aurora master user is not a '
      'real superuser and cannot ALTER ROLE ... NOSUPERUSER/NOREPLICATION/NOBYPASSRLS on a role '
      'that already has one of these set. Fix manually as an actual PostgreSQL superuser (not '
      'available on RDS/Aurora — this may require an AWS-support-assisted role reset, or dropping '
      'and recreating the role), then re-run `make migrate`.',
      r.rolsuper, r.rolreplication, r.rolbypassrls;
  END IF;
END $$;
