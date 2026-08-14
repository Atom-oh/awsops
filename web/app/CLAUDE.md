# App Routes Module

## Role
Next.js App Router — 36 pages + 86 API routes (`app/api/`). APIs are thin-BFF: Aurora reads, AWS SDK reads, and AgentCore calls only. Long/OOM-risk work is enqueued via `POST /api/jobs`.

## Structure
- Pages: overview `page.tsx`, `inventory/[type]` · `inventory/g/[group]`, `eks/` (overview · nodes · pods · deployments · services · explorer · cost · `[cluster]`), `topology/` (overview · infra · services · `resource/[id]`), `monitoring`, `network-flow`, `dns-query`, `ip-addresses`, `vpc-endpoints`, `direct-connect`, `network-firewall`, `security`, `compliance`, `cost`, `bedrock`, `agentcore`, `ai-diagnosis`, `assistant`, `datasources`, `integrations` (+`datasources/[id]`), `accounts`, `customization`, `jobs`, `login`.
- API (`app/api/`): accounts, actions, agentcore, ai-usage, anfw, auth(login/signout), bedrock-metrics, changelog, chat(+threads/stats), compliance, cost, customization, datasources, db, diagnosis, dns-logs, dx, eks, graph, health, incidents, insights, integrations, inventory, ip-inventory, jobs, me, monitoring, nfm, opencost, overview, security, sg, stream, tgw, vpce.

## Rules
- Auth: private APIs call `verifyUser(request.headers.get('cookie'))` (`lib/auth.ts`, re-verifies the `awsops_token` cookie via RS256 JWKS) → 401 if null. Admin-only routes additionally check `isAdmin()` (`lib/admin.ts`). Only `/api/health` is public.
- Route handlers declare `export const dynamic = 'force-dynamic'` (consistent across the existing 91 files).
- `api/chat`'s `aws-data` (Steampipe SQL, `lib/aws-data.ts`) and the 6 auto-collect collectors (`lib/collectors/`) are **local handlers** — they have no AgentCore gateway behind them, so they're excluded from ADR-003[legacy 044]'s multi-route fan-out (fan-out covers only gateway-backed built-ins).
- Request bodies are parsed via `readJsonBounded` (`lib/http-body.ts`) — a streaming cap, doubled up with `middleware.ts`'s 2MB belt.
- Fetch paths are `/api/*` — the v1 `/awsops` prefix is banned (no basePath).
- When adding a new page, also register it in `components/shell/Sidebar.tsx` and add its nav key to `lib/i18n.ts`.
