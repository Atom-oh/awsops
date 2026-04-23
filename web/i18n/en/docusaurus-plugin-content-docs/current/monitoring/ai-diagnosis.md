---
sidebar_position: 8
title: AI Comprehensive Diagnosis
description: 15-section Bedrock Opus diagnosis report, DOCX/MD/PDF export, auto-scheduling
---

# AI Comprehensive Diagnosis

Generate a **15-section AI diagnosis report** for your entire AWSops infrastructure and export it as DOCX, Markdown, PDF, or PPTX (`/ai-diagnosis`).

## Overview

Amazon Bedrock Claude Opus (or Sonnet) analyzes Steampipe inventory, CloudWatch metrics, Cost Explorer, and compliance results together and stitches them into a single report. Use it for monthly operational reviews, quarterly architecture reviews, or audit responses.

| Item | Value |
|------|-------|
| **Model** | `global.anthropic.claude-sonnet-4-6` (default), Opus selectable |
| **Sections** | 15 (Executive Summary → Action Plan) |
| **Output formats** | DOCX (A4, TOC), Markdown, PDF, PPTX |
| **Storage** | S3 report bucket + metadata in `data/reports/*.json` |
| **Schedule** | none / weekly / biweekly / monthly |

## 15 Sections

| # | Section | Source |
|---|---------|--------|
| 1 | Executive Summary | Aggregated from all sections |
| 2 | Resource Inventory | `data/inventory/*.json` |
| 3 | Compute (EC2/Lambda/ECS/EKS) | Steampipe + CloudWatch |
| 4 | Storage & DB (S3/EBS/RDS/DDB) | Steampipe + CW |
| 5 | Network & CDN (VPC/CloudFront/WAF) | Steampipe |
| 6 | Security (IAM/Public/Open SG) | Steampipe + Compliance |
| 7 | Compliance (CIS Benchmark) | Powerpipe results |
| 8 | Cost Analysis | Cost Explorer + snapshot |
| 9 | Resource Trend | Resource Inventory |
| 10 | Performance Anomalies | CloudWatch metrics |
| 11 | Incident History & Alert Correlation | Alert Knowledge Base |
| 12 | External Datasource Summary | Prometheus/Loki etc. |
| 13 | AI Conversation Usage | AgentCore Memory stats |
| 14 | Key Risks & Recommendations | AI synthesis |
| 15 | Action Plan (30/60/90 days) | AI synthesis |

## Running a Diagnosis

### Manual run

1. Click **AI Diagnosis** in the sidebar.
2. Click **Run Diagnosis**.
3. Watch the per-section progress indicator (average 3–6 min).
4. A new report card appears at the top of the list when complete.

:::tip Duration
With Opus + 15 sections, average runtime is 4–6 minutes. Many accounts or slow Cost API responses can push this to 10 minutes.
:::

### Auto-scheduling

| Schedule | When |
|----------|------|
| `weekly` | Every Monday at 9 AM KST |
| `biweekly` | Every other Monday at 9 AM |
| `monthly` | 1st of every month at 9 AM |
| `none` | Disabled |

Set this via `reportSchedule` in `data/config.json`, or use the **Schedule** dropdown in the UI.

## Export Formats

| Format | Use case | Details |
|--------|----------|---------|
| **DOCX** | Deliverables | A4, auto-generated TOC, tables and charts |
| **Markdown** | GitHub/Notion paste | Raw text with image links |
| **PDF** | Print/email | DOCX-converted, fonts embedded |
| **PPTX** | Executive brief | WADD-style, 1–2 slides per section |

:::info Report proxy download
Instead of exposing the S3 URL directly, the Next.js API generates a presigned URL and proxies the download. Large files (100MB+) can be downloaded without exposing credentials (ADR-014).
:::

## Notification Integration

On completion, notifications are sent to the configured channels:

- **Slack**: Block Kit card with risk count, severity, download links
- **Email**: summary + PDF attachment to users in `adminEmails`

Configure channels in `notificationChannels` in `data/config.json`.

## Alert-Triggered Diagnosis

When a real-time alert (CloudWatch/Alertmanager/Grafana) aggregates to `critical` severity, AWSops automatically runs a scoped partial diagnosis:

- Scope limited to affected services/resources/namespaces
- Only 3–5 relevant sections are regenerated (1–2 min)
- Results posted as a reply on the alert's Slack thread

See [Alert Pipeline](./alerts.md) for details.

## Tips

### Cost control
Opus costs about 5× Sonnet. Instead of weekly Opus, use **monthly Opus + weekly Sonnet**. The model picker is in the UI.

### Running specific sections
Call the API directly to skip sections:
```bash
curl -X POST /awsops/api/report \
  -H 'Content-Type: application/json' \
  -d '{"sections": ["cost", "compliance"], "model": "sonnet"}'
```

### Diff against previous report
Toggle **Compare with previous** to include a diff against the prior report.

## Related Pages

- [Alert Pipeline](./alerts.md) — alert-triggered partial diagnosis
- [Resource Inventory](./inventory.md) — source for section 2
- [Compliance](../security/compliance) — source for section 7
- [Cost Explorer](./cost) — source for section 8

## References

- ADR-019: Diagnosis report format matrix
- ADR-014: Report proxy download URL
- ADR-016: Bedrock model selection strategy
