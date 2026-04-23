// Slack notification client — Block Kit message builder + Web API / Webhook
// Slack 알림 클라이언트 — Block Kit 메시지 빌더 + Web API / Webhook
// ADR-009

import type { SlackConfig } from '@/lib/app-config';
import type { Incident, DiagnosisResult, AlertSeverity } from '@/lib/alert-types';

// --- Public API ---

export async function sendSlackAlert(
  incident: Incident,
  result: DiagnosisResult,
  config: SlackConfig,
): Promise<void> {
  const channel = getChannelForSeverity(incident.severity, config);
  const blocks = buildAlertBlocks(incident, result);
  const text = `[${incident.severity.toUpperCase()}] ${incident.primaryAlert.alertName} — ${result.rootCause}`;

  if (config.method === 'bot' && config.botToken) {
    await postWithBotToken(config.botToken, channel, text, blocks);
  } else if (config.webhookUrl) {
    await postWithWebhook(config.webhookUrl, text, blocks);
  }
}

export async function sendSlackResolvedUpdate(
  incident: Incident,
  threadTs: string,
  config: SlackConfig,
): Promise<void> {
  const channel = getChannelForSeverity(incident.severity, config);
  const duration = incident.resolvedAt && incident.createdAt
    ? formatDuration(new Date(incident.resolvedAt).getTime() - new Date(incident.createdAt).getTime())
    : 'unknown';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:white_check_mark: *Alert resolved* after ${duration}\n` +
          `Root cause: ${incident.diagnosisResult?.rootCause || 'see above'}`,
      },
    },
  ];

  if (config.method === 'bot' && config.botToken) {
    await postWithBotToken(config.botToken, channel, 'Alert resolved', blocks, threadTs);
  } else if (config.webhookUrl) {
    // Webhook mode: Slack Incoming Webhooks accept thread_ts in the payload when
    // the webhook targets the same channel as the parent message. If the workspace
    // hasn't granted threading, it falls back to a channel-level message.
    await postWithWebhook(config.webhookUrl, 'Alert resolved', blocks, threadTs);
  }
}

export async function testSlackConnection(config: SlackConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    if (config.method === 'bot' && config.botToken) {
      const resp = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.botToken}`,
          'Content-Type': 'application/json',
        },
      });
      const data = await resp.json() as { ok: boolean; error?: string };
      return { ok: data.ok, error: data.error };
    } else if (config.webhookUrl) {
      const resp = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ':white_check_mark: AWSops Slack integration test successful' }),
      });
      return { ok: resp.ok, error: resp.ok ? undefined : `HTTP ${resp.status}` };
    }
    return { ok: false, error: 'No bot token or webhook URL configured' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// --- Block Kit Message Builder ---

function buildAlertBlocks(incident: Incident, result: DiagnosisResult): unknown[] {
  const severityEmoji = incident.severity === 'critical' ? ':rotating_light:' : incident.severity === 'warning' ? ':warning:' : ':information_source:';
  const confidenceEmoji = result.confidence === 'high' ? ':dart:' : result.confidence === 'medium' ? ':thinking_face:' : ':question:';

  const blocks: unknown[] = [];

  // Header
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `${severityEmoji} Incident ${incident.id}`,
      emoji: true,
    },
  });

  // Alert summary
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*[${incident.severity.toUpperCase()}]* ${incident.primaryAlert.alertName}\n` +
        `*Source:* ${incident.primaryAlert.source} | *Alerts:* ${incident.alerts.length} correlated\n` +
        `*Services:* ${incident.affectedServices.join(', ') || 'unknown'}\n` +
        `*Resources:* ${incident.affectedResources.slice(0, 3).join(', ') || 'unknown'}`,
    },
  });

  blocks.push({ type: 'divider' });

  // Root cause
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${confidenceEmoji} *Root Cause* (${result.confidence} confidence):\n${result.rootCause}`,
    },
  });

  // Diagnosis summary (truncated to Slack's 3000-char block limit)
  const diagnosisPreview = extractSection(result.markdown, 'Remediation') ||
    extractSection(result.markdown, '4.') ||
    result.markdown;
  const truncated = diagnosisPreview.slice(0, 2500);

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: truncated + (diagnosisPreview.length > 2500 ? '\n_...see full diagnosis in dashboard_' : ''),
    },
  });

  blocks.push({ type: 'divider' });

  // Metadata footer
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Category: \`${result.rootCauseCategory}\` | Sources: ${result.investigationSources.join(', ')} | Analysis: ${(result.processingTimeMs / 1000).toFixed(1)}s`,
      },
    ],
  });

  // Actions
  const dashboardBase = 'https://awsops.atomai.click/awsops';
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'View in Dashboard', emoji: true },
        url: `${dashboardBase}/alert-settings?incident=${incident.id}`,
      },
    ],
  });

  return blocks;
}

// --- Slack API Calls ---

async function postWithBotToken(
  token: string,
  channel: string,
  text: string,
  blocks: unknown[],
  threadTs?: string,
): Promise<void> {
  const payload: Record<string, unknown> = {
    channel,
    text,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  };
  if (threadTs) payload.thread_ts = threadTs;

  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json() as { ok: boolean; error?: string };
  if (!data.ok) {
    console.error(`[Slack] postMessage failed: ${data.error}`);
  }
}

async function postWithWebhook(
  webhookUrl: string,
  text: string,
  blocks: unknown[],
  threadTs?: string,
): Promise<void> {
  const payload: Record<string, unknown> = { text, blocks };
  if (threadTs) payload.thread_ts = threadTs;

  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    console.error(`[Slack] Webhook failed: ${resp.status} ${resp.statusText}`);
  }
}

// --- Utilities ---

function getChannelForSeverity(severity: AlertSeverity, config: SlackConfig): string {
  return config.channelMapping?.[severity] || config.defaultChannel || '#ops-alerts';
}

function extractSection(markdown: string, heading: string): string | null {
  const regex = new RegExp(`###?\\s*\\d*\\.?\\s*${heading}[\\s\\S]*?(?=###?\\s|$)`, 'i');
  const match = markdown.match(regex);
  return match ? match[0].trim() : null;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}
