# Plan: Integration Credential UI — credential-write UX (single secret)

> Spec: `docs/superpowers/specs/2026-06-15-integration-credential-ui-design.md`.
> An admin sets an integration's credential in the customization UI; the BFF stores it in ONE
> Secrets Manager secret (`ops/${project}/integrations/credentials`) as a JSON map keyed by slug;
> the connector Lambda reads that single secret and extracts its slug. Token never returned/logged.
> TF owns the secret's existence; the BFF owns its value (PutSecretValue only). MODIFIES the shipped
> Notion connector (per-notion secret → single secret + slug). Branch `fix/v2-upgrade-snapshot-id`.

## Grounding (verified)
- BFF AWS SDK pattern (`web/lib/admin.ts`): lazy singleton `new SSMClient({region})` + `.send(new Cmd)`;
  tests `vi.mock('@aws-sdk/client-ssm', …)`. Mirror for `@aws-sdk/client-secrets-manager` (NOT yet a dep).
- Integrations: `name` is the unique key (`ON CONFLICT(name)`); there is NO slug column → **slug = name**.
  Connector reads `creds[INTEGRATION_SLUG]` (Notion: `INTEGRATION_SLUG=notion`).
- Web task role currently has only `secretsmanager:GetSecretValue` (`workload.tf:39`); needs PutSecretValue.
- `/api/integrations` is `isAdmin`-gated (mirror for the new credential route).
- The Notion connector's per-notion secret (ai.tf) + `notion_mcp.py` fixed-name read are REPLACED here.

## Non-goals
- Per-integration secrets, secret rotation, CreateSecret-from-UI, concurrency locking
  (last-write-wins, documented). No mutation/autonomy (read-only stance holds).

## Tasks (TDD; per-task commit; vitest / `python3 -m unittest` / `terraform validate` green each task)

### Task 1: Secrets Manager credential helper (BFF)
**Files:**
- Modify: `web/package.json`
- Create: `web/lib/integration-credentials.ts`
- Test: `web/lib/integration-credentials.test.ts`
- [ ] Add `@aws-sdk/client-secrets-manager` to `web/package.json` deps; `npm install` in `web/`.
- [ ] Failing tests (vitest; `vi.mock('@aws-sdk/client-secrets-manager', …)` mirroring `admin.test.ts`):
  - `setIntegrationCredential('notion', {token:'x'})`: calls GetSecretValue then PutSecretValue with the
    MERGED map (a pre-existing `{"datadog":{...}}` is preserved; `notion` added).
  - First write: GetSecretValue throws `ResourceNotFoundException` (or returns no `SecretString`) →
    treated as `{}` → PutSecretValue `{"notion":{...}}`.
  - `getConfiguredSlugs()` returns KEYS only (`['datadog','notion']`) — assert NO secret values appear.
  - slug allowlist: an unknown slug (not in the known-integration set) → throws/rejected, no SM call.
  - payload size bound: an oversized secret value → rejected.
- [ ] Implement `web/lib/integration-credentials.ts`: lazy `SecretsManagerClient` singleton (region
  from env, mirror `lib/admin.ts`); `SECRET_NAME = ops/${project}/integrations/credentials` (project
  from env, default `awsops-v2`); `setIntegrationCredential`, `getConfiguredSlugs`, slug allowlist
  constant + size bound. Returns nothing sensitive.
- [ ] `cd web && npx vitest run lib/integration-credentials.test.ts` → green.
- [ ] Commit: `feat(integrations): SM credential read-modify-write helper (single secret, slug-keyed)`.

### Task 2: admin credential route (BFF)
**Files:**
- Create: `web/app/api/integrations/credential/route.ts`
- Test: `web/app/api/integrations/credential/route.test.ts`
- [ ] Failing tests (mirror `web/app/api/integrations/route.test.ts`): non-admin → 403; `PUT
  {slug:'notion', secret:{token:'x'}}` → calls helper, returns `{ok:true}` and the response body
  contains NO token; `GET` → `{configured:[...slugs]}` with no values; malformed body → 400.
- [ ] Implement `route.ts`: `PUT` + `GET`, `isAdmin`-gated (mirror `/api/integrations`); delegates to
  `lib/integration-credentials`; never logs/echoes the secret.
- [ ] `cd web && npx vitest run app/api/integrations/credential/route.test.ts` → green.
- [ ] Commit: `feat(integrations): admin credential route — PUT set / GET configured-slugs (no values)`.

### Task 3: credential form in the customization Integrations section
**Files:**
- Modify: `web/app/customization/page.tsx`
- [ ] Add a per-integration masked token input + "Save credential" button → `PUT
  /api/integrations/credential {slug: row.name, secret:{token}}`; show `configured ✓/✗` from `GET
  /api/integrations/credential`. NEVER render the token value. Clear the input after save.
- [ ] `cd web && npm run build` (or `npx tsc --noEmit`) → no type/build error. (Light render test only
  if the page already has a test harness; otherwise build is the gate.)
- [ ] Commit: `feat(integrations): customization UI — per-integration credential form + configured status`.

### Task 4: connector reads the single secret by slug
**Files:**
- Modify: `agent/lambda/notion_mcp.py`
- Test: `agent/lambda/test_notion_mcp.py`
- [ ] Update/extend tests: `_get_token()` reads `INTEGRATIONS_SECRET_NAME` (single secret), parses the
  JSON map, extracts `map[INTEGRATION_SLUG]` (default `notion`) → `{"token":...}`; token cached
  per warm container; a missing slug key → structured "credential not configured" error.
- [ ] Implement: `_get_token()` reads the single secret + slug extraction (env `INTEGRATION_SLUG`,
  default `notion`; `INTEGRATIONS_SECRET_NAME` default `ops/awsops-v2/integrations/credentials`).
- [ ] `cd agent/lambda && python3 -m unittest test_notion_mcp` → green.
- [ ] Commit: `feat(agent-platform): notion_mcp reads single integrations secret by slug`.

### Task 5: single secret + lambda env/IAM (TF)
**Files:**
- Modify: `terraform/v2/foundation/ai.tf`
- [ ] Replace `aws_secretsmanager_secret.notion` with `aws_secretsmanager_secret.integrations`
  (`count = integ_count`, `name = ops/${var.project}/integrations/credentials`, default key, NO
  TF-managed version). Rename `agent_lambda_notion_secret` → `agent_lambda_integrations_secret`
  (`GetSecretValue` on the single secret ARN).
- [ ] notion Lambda env: `INTEGRATIONS_SECRET_NAME = aws_secretsmanager_secret.integrations[0].name`
  + `INTEGRATION_SLUG = "notion"` (replace the old `NOTION_SECRET_NAME`).
- [ ] `terraform -chdir=terraform/v2/foundation fmt` (revert any out-of-scope file fmt drift) +
  `validate` → green.
- [ ] Commit: `feat(agent-platform): single integrations secret + notion slug env (replaces per-notion secret)`.

### Task 6: web task role secret write grant (TF)
**Files:**
- Modify: `terraform/v2/foundation/workload.tf`
- [ ] Grant the web task role `secretsmanager:GetSecretValue` + `secretsmanager:PutSecretValue` on the
  single secret ARN (`aws_secretsmanager_secret.integrations[0].arn`) only, gated to match the
  secret's existence (`integ_count`). No `CreateSecret`, no `Principal:"*"`, no wildcard beyond the ARN.
- [ ] `terraform -chdir=terraform/v2/foundation fmt` + `validate` → green.
- [ ] Commit: `feat(integrations): web task role PutSecretValue on single integrations secret (scoped)`.

## Manual / live steps (NOT autonomous)
1. `terraform -target` apply for the single secret + IAM (ai.tf, workload.tf) — controller/user.
2. `make deploy` (web image with the new route/UI + SDK dep) and `make agentcore` (notion Lambda env).
3. Live: admin opens customization → Integrations → set the Notion token → connector reads it.
   (Admin gate must be open — see the connector plan's manual steps.)
4. Persist `integrations_enabled=true` in the live source-of-truth (already present — verify).
