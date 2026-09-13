# Troubleshooting

Use [AGENTS.md](../../AGENTS.md), root [CLAUDE.md](../../CLAUDE.md), and
[BASELINE.md](../../docs/decisions/BASELINE.md) for policy. Start with evidence
from the failing request, logs, and the relevant source.

| Symptom | Inspect |
| --- | --- |
| API 404 | `web/app/api/` and `web/next.config.mjs`; fetch paths are `/api/*`. |
| Authentication failure | Edge `is_public()`/JWT verification, `web/lib/auth.ts`, session revocation, and route authorization. |
| Build failure | Run `npm run build` in `web/`; use `web/package.json` for available scripts. |
| Unhealthy web task | `/api/health`, task logs, runtime `HOSTNAME=0.0.0.0`, and the private CloudFront-to-ALB path. |
| Missing agent tools | SSM configuration, provisioner catalog, runtime gateway resolution, and tool allowlists. |
| Stale inventory | Sync run/freshness records and `scripts/v2/steampipe/`; live Steampipe chat queries stay disabled. |
| Stuck job | `worker_jobs`, dispatcher/SFN execution, status updater, and reaper in `scripts/v2/workers/`. |

Deployment procedures are in `.claude/commands/deploy.md` and `docs/runbooks/`.
Do not infer a diagnosis from an old timing estimate or restart unrelated services.
