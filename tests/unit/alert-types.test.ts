// Unit tests for alert-types.ts — normalizers, ID generation, source detection, extraction
// ADR-009

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateAlertId,
  generateIncidentId,
  normalizeCloudWatch,
  normalizeAlertmanager,
  normalizeGrafana,
  normalizeGeneric,
  detectAlertSource,
  normalizeAlert,
  extractServices,
  extractResources,
} from '@/lib/alert-types';

// --- Test Fixtures ---

function cloudWatchSnsPayload(overrides: Record<string, unknown> = {}) {
  return {
    Type: 'Notification',
    TopicArn: 'arn:aws:sns:ap-northeast-2:111111111111:awsops-alert-topic',
    Message: JSON.stringify({
      AlarmName: 'HighCPUUtilization',
      AlarmDescription: 'CPU exceeds 90% for 5 minutes',
      AWSAccountId: '111111111111',
      NewStateValue: 'ALARM',
      NewStateReason: 'Threshold Crossed: 1 out of 1 datapoints [95.2] was >= 90',
      OldStateValue: 'OK',
      StateChangeTime: '2026-04-16T10:30:00.000+0000',
      Region: 'Asia Pacific (Seoul)',
      Trigger: {
        MetricName: 'CPUUtilization',
        Namespace: 'AWS/EC2',
        Threshold: 90,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        Dimensions: [
          { name: 'InstanceId', value: 'i-0abc123def456789' },
        ],
      },
      ...overrides,
    }),
  };
}

function alertmanagerPayload(overrides: Record<string, unknown> = {}) {
  return {
    receiver: 'awsops-webhook',
    status: 'firing',
    groupLabels: { alertname: 'HighMemoryUsage' },
    alerts: [
      {
        status: 'firing',
        labels: {
          alertname: 'HighMemoryUsage',
          severity: 'critical',
          namespace: 'production',
          pod: 'api-server-5d4f6b7c8-abc12',
          service: 'api-server',
          instance: '10.0.1.50:9090',
        },
        annotations: {
          summary: 'Pod api-server-5d4f6b7c8-abc12 memory usage is 95%',
          description: 'Memory usage exceeds threshold',
          runbook_url: 'https://wiki.internal/runbooks/high-memory',
        },
        startsAt: '2026-04-16T10:25:00.000Z',
        endsAt: '0001-01-01T00:00:00Z',
      },
    ],
    ...overrides,
  };
}

function grafanaPayload(overrides: Record<string, unknown> = {}) {
  return {
    orgId: 1,
    title: 'Latency Alert',
    message: 'Request latency above threshold',
    alerts: [
      {
        status: 'firing',
        labels: {
          alertname: 'HighLatency',
          severity: 'warning',
          service: 'payment-api',
        },
        annotations: {
          summary: 'p99 latency above 500ms',
          severity: 'warning',
        },
        startsAt: '2026-04-16T10:20:00.000Z',
        dashboardURL: 'https://grafana.internal/d/abc123/latency',
        panelURL: 'https://grafana.internal/d/abc123/latency?panelId=1',
        generatorURL: 'https://grafana.internal/alerting/abc123/edit',
      },
    ],
    ...overrides,
  };
}

function genericPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Disk Full Alert',
    severity: 'critical',
    status: 'firing',
    message: 'Disk usage on /data is 98%',
    timestamp: '2026-04-16T10:35:00.000Z',
    labels: { host: 'web-server-01', mount: '/data' },
    annotations: { description: 'Disk nearly full' },
    ...overrides,
  };
}

// ===== generateAlertId =====

describe('generateAlertId', () => {
  it('produces deterministic 16-char hex string', () => {
    const id1 = generateAlertId('cloudwatch', 'HighCPU', { region: 'us-east-1' });
    const id2 = generateAlertId('cloudwatch', 'HighCPU', { region: 'us-east-1' });
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[a-f0-9]{16}$/);
  });

  it('label order does not matter', () => {
    const a = generateAlertId('alertmanager', 'Test', { z: '1', a: '2' });
    const b = generateAlertId('alertmanager', 'Test', { a: '2', z: '1' });
    expect(a).toBe(b);
  });

  it('different sources produce different IDs', () => {
    const a = generateAlertId('cloudwatch', 'Alert', {});
    const b = generateAlertId('alertmanager', 'Alert', {});
    expect(a).not.toBe(b);
  });

  it('different labels produce different IDs', () => {
    const a = generateAlertId('generic', 'Alert', { host: 'a' });
    const b = generateAlertId('generic', 'Alert', { host: 'b' });
    expect(a).not.toBe(b);
  });
});

// ===== generateIncidentId =====

describe('generateIncidentId', () => {
  it('follows INC-YYYYMMDD-XXXXXX format', () => {
    const id = generateIncidentId();
    expect(id).toMatch(/^INC-\d{8}-[a-f0-9]{6}$/);
  });

  it('includes today date', () => {
    const id = generateIncidentId();
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    expect(id).toContain(today);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateIncidentId()));
    expect(ids.size).toBe(50);
  });
});

// ===== normalizeCloudWatch =====

describe('normalizeCloudWatch', () => {
  it('normalizes ALARM state to critical/firing', () => {
    const event = normalizeCloudWatch(cloudWatchSnsPayload());
    expect(event).not.toBeNull();
    expect(event!.source).toBe('cloudwatch');
    expect(event!.alertName).toBe('HighCPUUtilization');
    expect(event!.severity).toBe('critical');
    expect(event!.status).toBe('firing');
    expect(event!.message).toContain('Threshold Crossed');
  });

  it('extracts metric info from Trigger', () => {
    const event = normalizeCloudWatch(cloudWatchSnsPayload())!;
    expect(event.metric).toBeDefined();
    expect(event.metric!.name).toBe('CPUUtilization');
    expect(event.metric!.namespace).toBe('AWS/EC2');
    expect(event.metric!.threshold).toBe(90);
    expect(event.metric!.dimensions).toEqual({ InstanceId: 'i-0abc123def456789' });
  });

  it('extracts labels from Dimensions + region + account_id', () => {
    const event = normalizeCloudWatch(cloudWatchSnsPayload())!;
    expect(event.labels.InstanceId).toBe('i-0abc123def456789');
    expect(event.labels.region).toContain('Asia Pacific');
    expect(event.labels.account_id).toBe('111111111111');
    expect(event.labels.namespace).toBe('AWS/EC2');
  });

  it('maps OK → resolved/info', () => {
    const event = normalizeCloudWatch(cloudWatchSnsPayload({ NewStateValue: 'OK' }));
    expect(event!.severity).toBe('info');
    expect(event!.status).toBe('resolved');
  });

  it('maps INSUFFICIENT_DATA → warning/firing', () => {
    const event = normalizeCloudWatch(
      cloudWatchSnsPayload({ NewStateValue: 'INSUFFICIENT_DATA' }),
    );
    expect(event!.severity).toBe('warning');
    expect(event!.status).toBe('firing');
  });

  it('returns null for malformed payload', () => {
    const event = normalizeCloudWatch({ Message: 'not-json' });
    expect(event).toBeNull();
  });

  it('handles Message as object (non-string)', () => {
    const payload = {
      Type: 'Notification',
      Message: {
        AlarmName: 'DirectObject',
        NewStateValue: 'ALARM',
        Trigger: {},
      },
    };
    const event = normalizeCloudWatch(payload as Record<string, unknown>);
    expect(event).not.toBeNull();
    expect(event!.alertName).toBe('DirectObject');
  });

  it('generates deterministic IDs for same alarm', () => {
    const e1 = normalizeCloudWatch(cloudWatchSnsPayload())!;
    const e2 = normalizeCloudWatch(cloudWatchSnsPayload())!;
    expect(e1.id).toBe(e2.id);
  });
});

// ===== normalizeAlertmanager =====

describe('normalizeAlertmanager', () => {
  it('normalizes a single firing alert', () => {
    const events = normalizeAlertmanager(alertmanagerPayload());
    expect(events).toHaveLength(1);

    const e = events[0];
    expect(e.source).toBe('alertmanager');
    expect(e.alertName).toBe('HighMemoryUsage');
    expect(e.severity).toBe('critical');
    expect(e.status).toBe('firing');
    expect(e.message).toBe('Pod api-server-5d4f6b7c8-abc12 memory usage is 95%');
    expect(e.labels.namespace).toBe('production');
    expect(e.labels.pod).toBe('api-server-5d4f6b7c8-abc12');
  });

  it('normalizes multiple alerts', () => {
    const payload = alertmanagerPayload({
      alerts: [
        { status: 'firing', labels: { alertname: 'A', severity: 'warning' }, annotations: {}, startsAt: '2026-04-16T10:00:00Z' },
        { status: 'resolved', labels: { alertname: 'B', severity: 'info' }, annotations: {}, startsAt: '2026-04-16T10:01:00Z' },
      ],
    });
    const events = normalizeAlertmanager(payload);
    expect(events).toHaveLength(2);
    expect(events[0].alertName).toBe('A');
    expect(events[0].severity).toBe('warning');
    expect(events[1].alertName).toBe('B');
    expect(events[1].status).toBe('resolved');
  });

  it('returns empty array for payload without alerts', () => {
    const events = normalizeAlertmanager({ receiver: 'test' });
    expect(events).toEqual([]);
  });

  it('maps unknown severity to warning', () => {
    const events = normalizeAlertmanager({
      alerts: [{ labels: { alertname: 'X', severity: 'page' }, annotations: {}, status: 'firing' }],
    });
    expect(events[0].severity).toBe('warning');
  });
});

// ===== normalizeGrafana =====

describe('normalizeGrafana', () => {
  it('normalizes Grafana alert with dashboard/panel URLs', () => {
    const events = normalizeGrafana(grafanaPayload());
    expect(events).toHaveLength(1);

    const e = events[0];
    expect(e.source).toBe('grafana');
    expect(e.alertName).toBe('HighLatency');
    expect(e.severity).toBe('warning');
    expect(e.annotations.dashboardURL).toContain('grafana.internal');
    expect(e.annotations.panelURL).toContain('panelId=1');
  });

  it('falls back to body title if labels.alertname missing', () => {
    const payload = grafanaPayload();
    delete (payload.alerts[0].labels as Record<string, unknown>).alertname;
    const events = normalizeGrafana(payload);
    expect(events[0].alertName).toBe('Latency Alert');
  });

  it('reads severity from annotations if labels missing', () => {
    const payload = grafanaPayload();
    delete (payload.alerts[0].labels as Record<string, unknown>).severity;
    (payload.alerts[0].annotations as Record<string, string>).severity = 'critical';
    const events = normalizeGrafana(payload);
    expect(events[0].severity).toBe('critical');
  });
});

// ===== normalizeGeneric =====

describe('normalizeGeneric', () => {
  it('normalizes generic webhook payload', () => {
    const event = normalizeGeneric(genericPayload());
    expect(event).not.toBeNull();
    expect(event!.source).toBe('generic');
    expect(event!.alertName).toBe('Disk Full Alert');
    expect(event!.severity).toBe('critical');
    expect(event!.status).toBe('firing');
    expect(event!.labels.host).toBe('web-server-01');
  });

  it('accepts alternative field names (alertName, name)', () => {
    const event = normalizeGeneric({ alertName: 'MyAlert' });
    expect(event!.alertName).toBe('MyAlert');

    const event2 = normalizeGeneric({ name: 'NamedAlert' });
    expect(event2!.alertName).toBe('NamedAlert');
  });

  it('defaults to warning severity and firing status', () => {
    const event = normalizeGeneric({});
    expect(event!.severity).toBe('warning');
    expect(event!.status).toBe('firing');
  });

  it('sets source=sqs when body.source is sqs', () => {
    const event = normalizeGeneric({ source: 'sqs', title: 'SQSAlert' });
    expect(event!.source).toBe('sqs');
  });

  it('falls back to description for message', () => {
    const event = normalizeGeneric({ description: 'My desc' });
    expect(event!.message).toBe('My desc');
  });
});

// ===== detectAlertSource =====

describe('detectAlertSource', () => {
  it('detects CloudWatch SNS Notification', () => {
    expect(detectAlertSource({
      Type: 'Notification', Message: '{}', TopicArn: 'arn:aws:sns:...',
    })).toBe('cloudwatch');
  });

  it('detects SNS SubscriptionConfirmation', () => {
    expect(detectAlertSource({ Type: 'SubscriptionConfirmation' })).toBe('cloudwatch');
  });

  it('detects Alertmanager (receiver + groupLabels)', () => {
    expect(detectAlertSource({
      receiver: 'webhook', groupLabels: {}, alerts: [],
    })).toBe('alertmanager');
  });

  it('detects Grafana (orgId)', () => {
    expect(detectAlertSource({ orgId: 1, alerts: [] })).toBe('grafana');
  });

  it('detects Grafana by dashboardURL in first alert', () => {
    expect(detectAlertSource({
      alerts: [{ dashboardURL: 'https://grafana/d/1' }],
    })).toBe('grafana');
  });

  it('detects SQS source flag', () => {
    expect(detectAlertSource({ source: 'sqs' })).toBe('sqs');
  });

  it('falls back to alertmanager for generic alerts[] payload', () => {
    expect(detectAlertSource({ alerts: [{ labels: {} }] })).toBe('alertmanager');
  });

  it('returns generic for unrecognized payload', () => {
    expect(detectAlertSource({ foo: 'bar' })).toBe('generic');
  });
});

// ===== normalizeAlert (router) =====

describe('normalizeAlert', () => {
  it('routes CloudWatch payload to normalizeCloudWatch', () => {
    const results = normalizeAlert(cloudWatchSnsPayload());
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('cloudwatch');
  });

  it('routes Alertmanager payload', () => {
    const results = normalizeAlert(alertmanagerPayload());
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('alertmanager');
  });

  it('routes Grafana payload', () => {
    const results = normalizeAlert(grafanaPayload());
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('grafana');
  });

  it('respects sourceHint override', () => {
    const results = normalizeAlert(genericPayload(), 'generic');
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('generic');
  });

  it('returns empty array for malformed CloudWatch SNS payload', () => {
    // This is detected as cloudwatch (Type + TopicArn) but Message is invalid JSON
    const results = normalizeAlert({
      Type: 'Notification',
      TopicArn: 'arn:aws:sns:us-east-1:111:test',
      Message: '{{{invalid',
    });
    expect(results).toHaveLength(0);
  });
});

// ===== extractServices =====

describe('extractServices', () => {
  it('extracts service, job, app from labels', () => {
    const alert = normalizeAlertmanager(alertmanagerPayload())[0];
    const services = extractServices(alert);
    expect(services).toContain('api-server');
  });

  it('creates namespace/app composite', () => {
    const alert = normalizeAlertmanager({
      alerts: [{
        labels: { alertname: 'X', namespace: 'prod', app: 'web' },
        annotations: {}, status: 'firing',
      }],
    })[0];
    const services = extractServices(alert);
    expect(services).toContain('web');
    expect(services).toContain('prod/web');
  });

  it('extracts from metric namespace', () => {
    const alert = normalizeCloudWatch(cloudWatchSnsPayload())!;
    const services = extractServices(alert);
    expect(services).toContain('AWS/EC2');
  });

  it('returns empty for alert with no service labels', () => {
    const alert = normalizeGeneric({ title: 'NoLabels' })!;
    const services = extractServices(alert);
    expect(services).toHaveLength(0);
  });
});

// ===== extractResources =====

describe('extractResources', () => {
  it('extracts instance, pod, node from labels', () => {
    const alert = normalizeAlertmanager(alertmanagerPayload())[0];
    const resources = extractResources(alert);
    expect(resources).toContain('api-server-5d4f6b7c8-abc12');
    expect(resources).toContain('10.0.1.50:9090');
  });

  it('extracts InstanceId from CloudWatch dimensions', () => {
    const alert = normalizeCloudWatch(cloudWatchSnsPayload())!;
    const resources = extractResources(alert);
    expect(resources).toContain('i-0abc123def456789');
  });

  it('extracts DBInstanceIdentifier and ClusterName from labels', () => {
    const alert = normalizeGeneric({
      title: 'RDS',
      labels: { DBInstanceIdentifier: 'mydb-01', ClusterName: 'eks-prod' },
    })!;
    const resources = extractResources(alert);
    expect(resources).toContain('mydb-01');
    expect(resources).toContain('eks-prod');
  });

  it('returns empty for alert with no resource labels', () => {
    const alert = normalizeGeneric({ title: 'Empty' })!;
    const resources = extractResources(alert);
    expect(resources).toHaveLength(0);
  });
});
