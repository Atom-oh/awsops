# Start development services

Production v2 runs as ECS services. Do not start a second Next.js or Steampipe
process on an old EC2 host; that was the retired v1 procedure.

For local UI work, from the repository root:

```bash
npm ci --prefix web
cp web/.env.example web/.env.local
(cd web && npm run dev)
```

Fill required local configuration without committing secrets. Database-backed pages
require Aurora connectivity; the old embedded Steampipe database is not app state.
Check `/api/health` and the relevant authenticated route. For a production failure,
inspect ECS service events, task health and application logs before taking action.
Use [deployment](deploy-new-version.md) for a reviewed release or restart procedure,
and [onboarding](../onboarding.md) for environment setup.
