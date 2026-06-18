<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: d289eadeee17 · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

# AI Diagnosis module (v1 `src/`)

## What it is
A comprehensive infrastructure-diagnosis page: a fixed 15-section analysis powered by Bedrock Opus. Results render in-page (TOC sidebar, multi-expand) and export to DOCX / PPTX / PDF, with weekly/biweekly/monthly auto-scheduling.

## Scope note (v1 vs v2)
This lives under the **v1 app** (`src/`, Next.js client pages + Steampipe + `/awsops` basePath). The v2 stack (`web/`, `terraform/v2/`) is a separate rebuild with different rules — do **not** apply v2 conventions here, and vice-versa.

## Layout & boundaries
- `page.tsx` — diagnosis run/view UI.
- `report/page.tsx` — print-only report (white bg, A4 page breaks, browser Print-to-PDF).
- All real work lives in `src/lib/`, not in the page: data-collection orchestration (Steampipe + CloudWatch + external datasources), the 15-section prompt definitions, DOCX/PPTX builders, and the cron scheduler. The API route handles generation, history (GET), and S3 persistence. Keep pages thin — they call the route / lib, they don't embed collection or export logic.

## Conventions a reviewer must enforce
- Page files start with `'use client'`.
- Every fetch URL uses the `/awsops/api/*` prefix (v1 basePath rule).
- Component imports are default-export (`import X from '...'`).
- The 15 sections have a **fixed order** defined in the prompts lib — section additions/reorders happen there, not ad hoc in the page.
- Reports persist to S3 (configured bucket) with a gitignored local `reports/` cache.
- Large outputs must stream-render (the markdown render component), not block on the full payload.
- Download filenames follow `awsops-diagnosis-{YYYYMMDD}-{accountAlias}.{ext}`.
- Scheduling is **admin-only** — gated on the configured admin-emails check.

## Gotchas / banned patterns
- **Do not add a new PDF library** — PDFs are produced via browser print on purpose (bundle-size constraint). New heavyweight PDF deps are a reject.
- Don't bypass the admin-emails gate on scheduling.
- Don't hardcode the report bucket or account identifiers — they come from config.
