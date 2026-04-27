// Bedrock prompts for event-driven pre-scaling (ADR-010 Phase 1+2)
// 이벤트 기반 사전 스케일링용 Bedrock 프롬프트

import type { ScalingEvent, MetricsSnapshot, ReferenceEvent } from '@/lib/event-scaling';

export const SCALING_SYSTEM_PROMPT = (lang: 'ko' | 'en'): string => `You are an expert SRE generating staged pre-scaling plans for AWS infrastructure.

## Goal
Given an upcoming traffic event, reference event metrics, and current resource state, produce a multi-phase warm-up plan that scales:
- KEDA ScaledObjects (minReplicaCount), HPA min replicas
- Aurora read replicas, Aurora ACU (Serverless v2)
- MSK broker count, partition count
- EC2 ASG (min/desired)
- EBS IOPS / throughput
- ALB capacity (LCU pre-warming via AWS Support — note as manual action)

## Hard Rules
1. Phases must be ordered by scheduledOffsetMinutes (negative = before eventStart). Earlier-T phases run FIRST.
2. Storage / DB warm-up runs FIRST (Phase 1), compute scaling runs LAST (Phase 3-4). Never scale everything at once.
3. Each target MUST include rationale citing the metric or ratio used (e.g. "RDS CPU peaked at 78% during 2025-11-28 09:05; with 8x multiplier, current m6i.2xlarge needs 2 read replicas").
4. Targets must be CONSERVATIVE — round UP. Suggest separate manual review for >5x scale-ups.
5. Output must be MACHINE PARSABLE JSON between <PLAN_JSON> markers, followed by a markdown explanation.

## Output Format

<PLAN_JSON>
{
  "phases": [
    {
      "phaseNumber": 1,
      "label": "T-4h: storage + DB warm-up",
      "scheduledOffsetMinutes": -240,
      "targets": [
        {
          "resourceType": "ebs-iops",
          "resourceId": "vol-0123",
          "currentValue": 3000,
          "targetValue": 12000,
          "unit": "IOPS",
          "rationale": "..."
        }
      ],
      "notes": "..."
    }
  ],
  "estimatedAdditionalCostUsd": 234.5
}
</PLAN_JSON>

After the JSON block, write the analysis in ${lang === 'ko' ? 'Korean' : 'English'}:

### Reasoning
- Why this phasing order
- How target values were derived from reference metrics

### Risks
- What could go wrong
- Manual checks recommended before each phase

### Cooldown
- Suggested rollback order (reverse of warm-up)
`;

export function buildScalingUserPrompt(
  event: ScalingEvent,
  currentResources: Record<string, unknown>,
  lang: 'ko' | 'en',
): string {
  const refSummaries = event.referenceEvents
    .map(r => formatReferenceEvent(r))
    .join('\n\n');

  return `## Upcoming Event
- Name: ${event.name}
- Description: ${event.description || '(none)'}
- Window: ${event.eventStart} → ${event.eventEnd}
- Pattern: ${event.pattern.type}
- Expected peak multiplier: ${event.pattern.expectedPeakMultiplier}x
- Peak duration: ${event.pattern.durationMinutes} minutes
- Ramp-up window: ${event.pattern.rampUpMinutes} minutes
- Custom metrics to watch: ${event.pattern.customMetrics?.join(', ') || '(none)'}

## Reference Events (historical baseline)
${refSummaries || '(no reference events provided — use generic guidance for the pattern type)'}

## Current Resource State
\`\`\`json
${JSON.stringify(currentResources, null, 2).slice(0, 8000)}
\`\`\`

Generate the staged pre-scaling plan. Output JSON between <PLAN_JSON> markers, then ${lang === 'ko' ? 'Korean' : 'English'} reasoning, risks, and cooldown sections.
`;
}

function formatReferenceEvent(r: ReferenceEvent): string {
  const lines = [`### ${r.name} — ${r.date}`];
  if (r.metricsSnapshot) lines.push(formatMetricsSnapshot(r.metricsSnapshot));
  return lines.join('\n');
}

function formatMetricsSnapshot(snap: MetricsSnapshot): string {
  const lines: string[] = [
    `Window: ${snap.windowStart} → ${snap.windowEnd}`,
  ];
  if (snap.cloudwatch) {
    lines.push('CloudWatch peaks:');
    for (const [key, series] of Object.entries(snap.cloudwatch)) {
      lines.push(`  - ${key} (${series.unit}): peak=${series.peak ?? '?'} avg=${series.avg ?? '?'}`);
    }
  }
  if (snap.steampipe) {
    lines.push('Resource snapshot:');
    lines.push('```json');
    lines.push(JSON.stringify(snap.steampipe, null, 2).slice(0, 2000));
    lines.push('```');
  }
  return lines.join('\n');
}

// --- Plan extraction ---

export interface ParsedPlanResponse {
  json: {
    phases: Array<{
      phaseNumber: number;
      label: string;
      scheduledOffsetMinutes: number;
      targets: Array<{
        resourceType: string;
        resourceId: string;
        currentValue: number;
        targetValue: number;
        unit?: string;
        rationale?: string;
      }>;
      notes?: string;
    }>;
    estimatedAdditionalCostUsd?: number;
  } | null;
  markdown: string;
}

export function extractPlanFromResponse(content: string): ParsedPlanResponse {
  const match = content.match(/<PLAN_JSON>([\s\S]*?)<\/PLAN_JSON>/);
  if (!match) {
    return { json: null, markdown: content };
  }
  let parsed: ParsedPlanResponse['json'] = null;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    parsed = null;
  }
  const markdown = content.replace(match[0], '').trim();
  return { json: parsed, markdown };
}
