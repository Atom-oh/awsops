// Alert-triggered AI diagnosis — type definitions and normalizers
// 알림 트리거 AI 진단 — 타입 정의 및 정규화 함수
// ADR-009

import { createHash } from 'crypto';
import type { AlertSource } from '@/lib/app-config';

// --- Core Types ---

export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertStatus = 'firing' | 'resolved';

export interface AlertMetric {
  name: string;                          // e.g., "CPUUtilization", "http_requests_total"
  namespace?: string;                    // CloudWatch namespace or Prometheus job
  value?: number;
  threshold?: number;
  comparator?: string;                   // "GreaterThanThreshold", ">", etc.
  dimensions?: Record<string, string>;
}

export interface AlertEvent {
  id: string;                            // deterministic hash (source + alertName + labels)
  source: AlertSource;
  alertName: string;
  severity: AlertSeverity;
  status: AlertStatus;
  message: string;
  timestamp: string;                     // ISO 8601
  labels: Record<string, string>;        // namespace, service, instance, region, etc.
  annotations: Record<string, string>;   // summary, description, runbook_url
  metric?: AlertMetric;
  rawPayload: unknown;
  receivedAt: string;                    // when AWSops received this alert
}

export interface Incident {
  id: string;
  status: 'buffering' | 'investigating' | 'analyzed' | 'resolved';
  severity: AlertSeverity;
  alerts: AlertEvent[];
  primaryAlert: AlertEvent;              // highest-severity or earliest alert
  correlationReason: string;
  affectedServices: string[];
  affectedResources: string[];
  createdAt: string;
  analyzedAt?: string;
  resolvedAt?: string;
  diagnosisResult?: DiagnosisResult;
}

export interface DiagnosisResult {
  incidentId: string;
  markdown: string;                      // full AI analysis text
  rootCause: string;                     // one-line summary
  rootCauseCategory: RootCauseCategory;
  confidence: 'high' | 'medium' | 'low';
  investigationSources: string[];        // e.g., ["cloudwatch", "prometheus", "loki"]
  processingTimeMs: number;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type RootCauseCategory =
  | 'deployment'
  | 'capacity'
  | 'configuration'
  | 'dependency'
  | 'security'
  | 'infrastructure'
  | 'unknown';

// --- Alert ID Generation ---

export function generateAlertId(source: AlertSource, alertName: string, labels: Record<string, string>): string {
  const sortedLabels = Object.keys(labels).sort().map(k => `${k}=${labels[k]}`).join(',');
  const input = `${source}:${alertName}:${sortedLabels}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function generateIncidentId(): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 6);
  return `INC-${dateStr}-${rand}`;
}

// --- Source-Specific Normalizers ---

// CloudWatch Alarm via SNS HTTP subscription
export function normalizeCloudWatch(body: Record<string, unknown>): AlertEvent | null {
  try {
    // SNS wraps the alarm in a Message string
    const messageStr = typeof body.Message === 'string' ? body.Message : JSON.stringify(body.Message);
    const msg = JSON.parse(messageStr);

    const alertName = msg.AlarmName || 'UnknownAlarm';
    const newState = msg.NewStateValue as string;
    const trigger = msg.Trigger || {};
    const dimensions: Record<string, string> = {};
    if (Array.isArray(trigger.Dimensions)) {
      for (const d of trigger.Dimensions) {
        dimensions[d.name || d.Name] = d.value || d.Value;
      }
    }

    const labels: Record<string, string> = {
      ...dimensions,
      region: msg.Region || '',
      account_id: msg.AWSAccountId || '',
    };
    if (trigger.Namespace) labels.namespace = trigger.Namespace;

    const severity: AlertSeverity = newState === 'ALARM' ? 'critical' : newState === 'INSUFFICIENT_DATA' ? 'warning' : 'info';
    const status: AlertStatus = newState === 'OK' ? 'resolved' : 'firing';

    const id = generateAlertId('cloudwatch', alertName, labels);
    return {
      id,
      source: 'cloudwatch',
      alertName,
      severity,
      status,
      message: msg.NewStateReason || `Alarm ${alertName} transitioned to ${newState}`,
      timestamp: msg.StateChangeTime || new Date().toISOString(),
      labels,
      annotations: {
        description: msg.AlarmDescription || '',
        oldState: msg.OldStateValue || '',
        accountId: msg.AWSAccountId || '',
      },
      metric: {
        name: trigger.MetricName || '',
        namespace: trigger.Namespace || '',
        threshold: trigger.Threshold,
        comparator: trigger.ComparisonOperator || '',
        dimensions,
      },
      rawPayload: body,
      receivedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// Prometheus Alertmanager webhook format
export function normalizeAlertmanager(body: Record<string, unknown>): AlertEvent[] {
  const results: AlertEvent[] = [];
  const alerts = Array.isArray(body.alerts) ? body.alerts : [];

  for (const alert of alerts as Record<string, unknown>[]) {
    try {
      const labels = (alert.labels || {}) as Record<string, string>;
      const annotations = (alert.annotations || {}) as Record<string, string>;
      const alertName = labels.alertname || 'UnknownAlert';
      const severityRaw = labels.severity || 'warning';
      const severity: AlertSeverity = severityRaw === 'critical' ? 'critical' : severityRaw === 'info' ? 'info' : 'warning';
      const status: AlertStatus = (alert.status as string) === 'resolved' ? 'resolved' : 'firing';

      const id = generateAlertId('alertmanager', alertName, labels);
      results.push({
        id,
        source: 'alertmanager',
        alertName,
        severity,
        status,
        message: annotations.summary || annotations.description || `Alert ${alertName} is ${status}`,
        timestamp: (alert.startsAt as string) || new Date().toISOString(),
        labels,
        annotations,
        metric: labels.metric_name ? { name: labels.metric_name, namespace: labels.job } : undefined,
        rawPayload: alert,
        receivedAt: new Date().toISOString(),
      });
    } catch {
      // skip malformed alert
    }
  }
  return results;
}

// Grafana Alerting webhook contact point
export function normalizeGrafana(body: Record<string, unknown>): AlertEvent[] {
  const results: AlertEvent[] = [];
  const alerts = Array.isArray(body.alerts) ? body.alerts : [];

  for (const alert of alerts as Record<string, unknown>[]) {
    try {
      const labels = (alert.labels || {}) as Record<string, string>;
      const annotations = (alert.annotations || {}) as Record<string, string>;
      const alertName = labels.alertname || (body.title as string) || 'GrafanaAlert';
      const status: AlertStatus = (alert.status as string) === 'resolved' ? 'resolved' : 'firing';

      // Grafana severity from labels or annotations
      const severityRaw = labels.severity || annotations.severity || 'warning';
      const severity: AlertSeverity = severityRaw === 'critical' ? 'critical' : severityRaw === 'info' ? 'info' : 'warning';

      const id = generateAlertId('grafana', alertName, labels);
      results.push({
        id,
        source: 'grafana',
        alertName,
        severity,
        status,
        message: annotations.summary || annotations.description || (body.message as string) || alertName,
        timestamp: (alert.startsAt as string) || new Date().toISOString(),
        labels,
        annotations: {
          ...annotations,
          dashboardURL: (alert.dashboardURL as string) || '',
          panelURL: (alert.panelURL as string) || '',
          generatorURL: (alert.generatorURL as string) || '',
        },
        rawPayload: alert,
        receivedAt: new Date().toISOString(),
      });
    } catch {
      // skip malformed alert
    }
  }
  return results;
}

// Generic webhook format (also used for SQS messages)
export function normalizeGeneric(body: Record<string, unknown>): AlertEvent | null {
  try {
    const alertName = (body.title as string) || (body.alertName as string) || (body.name as string) || 'GenericAlert';
    const severityRaw = (body.severity as string) || 'warning';
    const severity: AlertSeverity = severityRaw === 'critical' ? 'critical' : severityRaw === 'info' ? 'info' : 'warning';
    const statusRaw = (body.status as string) || 'firing';
    const status: AlertStatus = statusRaw === 'resolved' ? 'resolved' : 'firing';
    const source = ((body.source as string) === 'sqs' ? 'sqs' : 'generic') as AlertSource;

    const labels = (body.labels || {}) as Record<string, string>;
    const id = generateAlertId(source, alertName, labels);

    return {
      id,
      source,
      alertName,
      severity,
      status,
      message: (body.message as string) || (body.description as string) || alertName,
      timestamp: (body.timestamp as string) || new Date().toISOString(),
      labels,
      annotations: (body.annotations || {}) as Record<string, string>,
      metric: body.metric ? (body.metric as AlertMetric) : undefined,
      rawPayload: body,
      receivedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// --- Source Detection ---

export function detectAlertSource(body: Record<string, unknown>): AlertSource {
  // CloudWatch via SNS: has Type and Message fields
  if (body.Type === 'Notification' && body.Message && body.TopicArn) return 'cloudwatch';
  if (body.Type === 'SubscriptionConfirmation') return 'cloudwatch';

  // Alertmanager: has alerts[] with labels.alertname and generatorURL
  if (Array.isArray(body.alerts) && body.receiver !== undefined && body.groupLabels !== undefined) return 'alertmanager';

  // Grafana: has alerts[] with dashboardURL or orgId
  if (Array.isArray(body.alerts) && (body.orgId !== undefined || body.dashboardURL !== undefined)) return 'grafana';
  if (Array.isArray(body.alerts)) {
    const first = (body.alerts as Record<string, unknown>[])[0];
    if (first?.dashboardURL || first?.panelURL) return 'grafana';
  }

  // SQS flag
  if (body.source === 'sqs') return 'sqs';

  // Alertmanager fallback: has alerts[] with startsAt
  if (Array.isArray(body.alerts)) return 'alertmanager';

  return 'generic';
}

// Normalize any incoming payload to AlertEvent(s)
export function normalizeAlert(body: Record<string, unknown>, sourceHint?: AlertSource): AlertEvent[] {
  const source = sourceHint || detectAlertSource(body);

  switch (source) {
    case 'cloudwatch': {
      const event = normalizeCloudWatch(body);
      return event ? [event] : [];
    }
    case 'alertmanager':
      return normalizeAlertmanager(body);
    case 'grafana':
      return normalizeGrafana(body);
    case 'sqs':
    case 'generic': {
      const event = normalizeGeneric(body);
      return event ? [event] : [];
    }
    default:
      return [];
  }
}

// --- Utility: Extract service/resource identifiers from labels ---

export function extractServices(alert: AlertEvent): string[] {
  const services = new Set<string>();
  const { labels } = alert;
  if (labels.service) services.add(labels.service);
  if (labels.job) services.add(labels.job);
  if (labels.app) services.add(labels.app);
  if (labels.namespace && labels.app) services.add(`${labels.namespace}/${labels.app}`);
  if (labels.Namespace) services.add(labels.Namespace);
  if (alert.metric?.namespace) services.add(alert.metric.namespace);
  return Array.from(services);
}

export function extractResources(alert: AlertEvent): string[] {
  const resources = new Set<string>();
  const { labels } = alert;
  if (labels.instance) resources.add(labels.instance);
  if (labels.pod) resources.add(labels.pod);
  if (labels.node) resources.add(labels.node);
  if (labels.container) resources.add(labels.container);
  if (labels.InstanceId) resources.add(labels.InstanceId);
  if (labels.DBInstanceIdentifier) resources.add(labels.DBInstanceIdentifier);
  if (labels.ClusterName) resources.add(labels.ClusterName);
  if (alert.metric?.dimensions) {
    for (const v of Object.values(alert.metric.dimensions)) {
      if (v) resources.add(v);
    }
  }
  return Array.from(resources);
}
