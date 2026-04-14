// SQS background poller for alert-triggered AI diagnosis
// SQS 백그라운드 폴러 — 알림 트리거 AI 진단
// ADR-009: Polls an SQS queue for alert messages, normalizes them, and feeds into the correlation engine.
// Follows the cache-warmer.ts pattern: lazy-init, isPolling guard, error isolation.

import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { getAlertSourceConfig } from '@/lib/app-config';
import { normalizeAlert } from '@/lib/alert-types';
import { ingestAlert } from '@/lib/alert-correlation';
import { ensureAlertDiagnosisStarted } from '@/lib/alert-diagnosis';

const POLL_INTERVAL_MS = 30_000; // 30 seconds
const MAX_MESSAGES = 10;
const VISIBILITY_TIMEOUT = 120; // seconds — enough for normalization + ingestion

let pollerTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;
let initialized = false;

interface SqsPollerStatus {
  isRunning: boolean;
  lastPollAt: string | null;
  messagesProcessed: number;
  lastError: string | null;
  startedAt: string | null;
}

const status: SqsPollerStatus = {
  isRunning: false,
  lastPollAt: null,
  messagesProcessed: 0,
  lastError: null,
  startedAt: null,
};

export function getSqsPollerStatus(): SqsPollerStatus {
  return { ...status };
}

export function ensureSqsPollerStarted(): void {
  if (initialized) return;

  const sqsConfig = getAlertSourceConfig('sqs');
  if (!sqsConfig?.enabled || !sqsConfig.queueUrl) return;

  initialized = true;
  status.startedAt = new Date().toISOString();

  // Ensure the diagnosis handler is registered
  ensureAlertDiagnosisStarted();

  // Initial poll after 15 seconds
  setTimeout(() => pollOnce(), 15_000);

  // Then every POLL_INTERVAL_MS
  pollerTimer = setInterval(() => pollOnce(), POLL_INTERVAL_MS);
  console.log(`[SqsPoller] Started — queue: ${sqsConfig.queueUrl}, interval: ${POLL_INTERVAL_MS / 1000}s`);
}

export function stopSqsPoller(): void {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
  }
  initialized = false;
  console.log('[SqsPoller] Stopped');
}

async function pollOnce(): Promise<void> {
  if (isPolling) return;

  const sqsConfig = getAlertSourceConfig('sqs');
  if (!sqsConfig?.enabled || !sqsConfig.queueUrl) return;

  isPolling = true;
  status.isRunning = true;

  try {
    const region = sqsConfig.region || 'ap-northeast-2';
    const client = new SQSClient({ region });

    const response = await client.send(new ReceiveMessageCommand({
      QueueUrl: sqsConfig.queueUrl,
      MaxNumberOfMessages: MAX_MESSAGES,
      WaitTimeSeconds: 5, // long polling (5s)
      VisibilityTimeout: VISIBILITY_TIMEOUT,
    }));

    const messages = response.Messages || [];
    status.lastPollAt = new Date().toISOString();

    for (const message of messages) {
      try {
        if (!message.Body || !message.ReceiptHandle) continue;

        // Parse message body — could be raw JSON or SNS-wrapped
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(message.Body);
        } catch {
          console.warn('[SqsPoller] Non-JSON message skipped:', message.MessageId);
          continue;
        }

        // Unwrap SNS envelope if present (CloudWatch Alarm → SNS → SQS)
        if (body.Type === 'Notification' && typeof body.Message === 'string') {
          // Keep the SNS envelope — normalizeAlert handles it
        }

        // Add SQS source hint
        if (!body.source) body.source = 'sqs';

        // Normalize and ingest
        const alerts = normalizeAlert(body, 'sqs');
        for (const alert of alerts) {
          ingestAlert(alert);
        }

        // Delete message on successful processing
        await client.send(new DeleteMessageCommand({
          QueueUrl: sqsConfig.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }));

        status.messagesProcessed++;
      } catch (err) {
        console.error(`[SqsPoller] Failed to process message ${message.MessageId}:`,
          err instanceof Error ? err.message : err);
        // Don't delete — let it return to queue after visibility timeout
      }
    }

    if (messages.length > 0) {
      console.log(`[SqsPoller] Processed ${messages.length} messages`);
    }

    status.lastError = null;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    status.lastError = errMsg;
    console.error('[SqsPoller] Poll failed:', errMsg);
  } finally {
    isPolling = false;
    status.isRunning = false;
  }
}
