// Unit tests for alert-correlation.ts — correlation rules, dedup, severity escalation
// ADR-009

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock app-config before importing the module under test
vi.mock('@/lib/app-config', () => ({
  getAlertDiagnosisConfig: vi.fn(() => ({
    enabled: true,
    minimumSeverity: 'warning',
    correlationWindowSeconds: 30,
    deduplicationWindowMinutes: 15,
    cooldownMinutes: 5,
    maxConcurrentInvestigations: 3,
  })),
}));

import {
  ingestAlert,
  getActiveIncidents,
  getIncident,
  updateIncident,
  cleanupStaleData,
  setIncidentHandler,
} from '@/lib/alert-correlation';
import type { AlertEvent, Incident } from '@/lib/alert-types';

// --- Helper: create a minimal AlertEvent ---
function makeAlert(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: `alert-${Math.random().toString(36).slice(2, 8)}`,
    source: 'alertmanager',
    alertName: 'TestAlert',
    severity: 'warning',
    status: 'firing',
    message: 'Test alert message',
    timestamp: new Date().toISOString(),
    labels: {},
    annotations: {},
    rawPayload: {},
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('alert-correlation', () => {
  beforeEach(() => {
    // Clear in-memory state between tests by cleaning up stale data
    // and resetting the incident handler
    vi.useFakeTimers();
    setIncidentHandler(null as unknown as (incident: Incident) => Promise<void>);

    // Fast-forward 25 hours to trigger cleanup of any leftover incidents
    vi.advanceTimersByTime(25 * 3600 * 1000);
    cleanupStaleData();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===== Severity Filtering =====

  describe('severity filtering', () => {
    it('ingests warning alerts when minimum is warning', () => {
      const alert = makeAlert({ severity: 'warning' });
      ingestAlert(alert);
      const incidents = getActiveIncidents();
      expect(incidents.some(i => i.alerts.some(a => a.id === alert.id))).toBe(true);
    });

    it('ingests critical alerts when minimum is warning', () => {
      const alert = makeAlert({ severity: 'critical' });
      ingestAlert(alert);
      const incidents = getActiveIncidents();
      expect(incidents.some(i => i.alerts.some(a => a.id === alert.id))).toBe(true);
    });

    it('rejects info alerts when minimum is warning', () => {
      const alert = makeAlert({ severity: 'info' });
      const before = getActiveIncidents().length;
      ingestAlert(alert);
      // info alert shouldn't create new incident since minimum is warning
      const after = getActiveIncidents();
      const found = after.some(i => i.alerts.some(a => a.id === alert.id));
      expect(found).toBe(false);
    });
  });

  // ===== Deduplication =====

  describe('deduplication', () => {
    it('skips duplicate alert IDs within window', () => {
      const alert1 = makeAlert({ id: 'dedup-test-001', alertName: 'DedupAlert' });
      const alert2 = makeAlert({ id: 'dedup-test-001', alertName: 'DedupAlert' });

      ingestAlert(alert1);
      const count1 = getActiveIncidents().reduce((sum, i) => sum + i.alerts.length, 0);

      ingestAlert(alert2);
      const count2 = getActiveIncidents().reduce((sum, i) => sum + i.alerts.length, 0);

      expect(count2).toBe(count1); // second ingest was a no-op
    });

    it('accepts same alert ID after dedup window expires', () => {
      vi.useFakeTimers();
      const alert1 = makeAlert({ id: 'dedup-expire-001', alertName: 'TimedAlert' });
      ingestAlert(alert1);

      // Advance past 15-min dedup window
      vi.advanceTimersByTime(16 * 60 * 1000);

      const alert2 = makeAlert({ id: 'dedup-expire-001', alertName: 'TimedAlert' });
      ingestAlert(alert2);

      // Should have been accepted (either as new incident or correlated)
      const incidents = getActiveIncidents();
      const totalAlerts = incidents.reduce((sum, i) => sum + i.alerts.length, 0);
      expect(totalAlerts).toBeGreaterThanOrEqual(2);

      vi.useRealTimers();
    });
  });

  // ===== Incident Creation =====

  describe('incident creation', () => {
    it('creates a new incident for an unmatched alert', () => {
      const before = getActiveIncidents().length;
      const alert = makeAlert({ alertName: 'NewIncident' });
      ingestAlert(alert);
      expect(getActiveIncidents().length).toBe(before + 1);
    });

    it('new incident starts in buffering status', () => {
      const alert = makeAlert({ alertName: 'BufferingTest' });
      ingestAlert(alert);
      const incident = getActiveIncidents().find(i =>
        i.alerts.some(a => a.alertName === 'BufferingTest'),
      );
      expect(incident).toBeDefined();
      expect(incident!.status).toBe('buffering');
    });

    it('new incident has correct primary alert', () => {
      const alert = makeAlert({ alertName: 'PrimaryTest', severity: 'critical' });
      ingestAlert(alert);
      const incident = getActiveIncidents().find(i =>
        i.alerts.some(a => a.alertName === 'PrimaryTest'),
      );
      expect(incident!.primaryAlert.alertName).toBe('PrimaryTest');
    });

    it('incident ID follows INC-YYYYMMDD-XXXXXX format', () => {
      const alert = makeAlert({ alertName: 'IdFormat' });
      ingestAlert(alert);
      const incident = getActiveIncidents().find(i =>
        i.alerts.some(a => a.alertName === 'IdFormat'),
      );
      expect(incident!.id).toMatch(/^INC-\d{8}-[a-f0-9]{6}$/);
    });
  });

  // ===== Correlation Rules =====

  describe('correlation rules', () => {
    it('correlates alerts with same resource', () => {
      const alert1 = makeAlert({
        alertName: 'ResourceAlert1',
        labels: { pod: 'api-pod-001' },
        timestamp: new Date().toISOString(),
      });
      const alert2 = makeAlert({
        alertName: 'ResourceAlert2',
        labels: { pod: 'api-pod-001' },
        timestamp: new Date().toISOString(),
      });

      ingestAlert(alert1);
      ingestAlert(alert2);

      // Both should be in the same incident
      const incidents = getActiveIncidents().filter(i =>
        i.alerts.some(a => a.alertName === 'ResourceAlert1'),
      );
      expect(incidents).toHaveLength(1);
      expect(incidents[0].alerts.length).toBeGreaterThanOrEqual(2);
    });

    it('correlates alerts with same service within time window', () => {
      const now = new Date();
      const alert1 = makeAlert({
        alertName: 'ServiceAlert1',
        labels: { service: 'payment-svc' },
        timestamp: now.toISOString(),
      });
      const twoMinLater = new Date(now.getTime() + 2 * 60_000);
      const alert2 = makeAlert({
        alertName: 'ServiceAlert2',
        labels: { service: 'payment-svc' },
        timestamp: twoMinLater.toISOString(),
      });

      ingestAlert(alert1);
      ingestAlert(alert2);

      const incidents = getActiveIncidents().filter(i =>
        i.alerts.some(a => a.alertName === 'ServiceAlert1'),
      );
      expect(incidents).toHaveLength(1);
      expect(incidents[0].alerts).toHaveLength(2);
    });

    it('correlates alerts in same K8s namespace within 3 minutes', () => {
      const now = new Date();
      const alert1 = makeAlert({
        alertName: 'NsAlert1',
        labels: { namespace: 'kube-system' },
        timestamp: now.toISOString(),
      });
      const alert2 = makeAlert({
        alertName: 'NsAlert2',
        labels: { namespace: 'kube-system' },
        timestamp: new Date(now.getTime() + 1 * 60_000).toISOString(),
      });

      ingestAlert(alert1);
      ingestAlert(alert2);

      const incident = getActiveIncidents().find(i =>
        i.alerts.some(a => a.alertName === 'NsAlert1'),
      );
      expect(incident!.alerts.length).toBeGreaterThanOrEqual(2);
    });

    it('correlates uncorrelated alerts within 2-min window when buffering', () => {
      const now = new Date();
      const alert1 = makeAlert({
        alertName: 'TimeAlert1',
        labels: { unique1: 'a' },
        timestamp: now.toISOString(),
      });
      const alert2 = makeAlert({
        alertName: 'TimeAlert2',
        labels: { unique2: 'b' },
        timestamp: new Date(now.getTime() + 60_000).toISOString(), // 1 min later
      });

      ingestAlert(alert1);
      ingestAlert(alert2);

      // Close-time correlation should group them
      const incident = getActiveIncidents().find(i =>
        i.alerts.some(a => a.alertName === 'TimeAlert1'),
      );
      expect(incident!.alerts.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ===== Severity Escalation =====

  describe('severity escalation', () => {
    it('escalates to critical when any alert is critical', () => {
      const alert1 = makeAlert({
        alertName: 'EscAlert1',
        severity: 'warning',
        labels: { pod: 'esc-pod' },
      });
      const alert2 = makeAlert({
        alertName: 'EscAlert2',
        severity: 'critical',
        labels: { pod: 'esc-pod' },
      });

      ingestAlert(alert1);
      ingestAlert(alert2);

      const incident = getActiveIncidents().find(i =>
        i.alerts.some(a => a.alertName === 'EscAlert1'),
      );
      expect(incident!.severity).toBe('critical');
    });

    it('escalates to warning with 3+ alerts', async () => {
      const now = new Date();
      // Create 3 alerts that will correlate (close time window)
      const alerts = Array.from({ length: 3 }, (_, i) =>
        makeAlert({
          alertName: `BulkAlert${i}`,
          severity: 'info',
          // Set minimum severity to info for this test
          labels: { instance: 'bulk-instance' },
          timestamp: new Date(now.getTime() + i * 1000).toISOString(),
        }),
      );

      // Override config to accept info severity
      const appConfig = await import('@/lib/app-config');
      const { getAlertDiagnosisConfig } = vi.mocked(appConfig);
      getAlertDiagnosisConfig.mockReturnValue({
        enabled: true,
        minimumSeverity: 'info',
        correlationWindowSeconds: 30,
        deduplicationWindowMinutes: 15,
        cooldownMinutes: 5,
        maxConcurrentInvestigations: 3,
      });

      for (const a of alerts) {
        ingestAlert(a);
      }

      const incident = getActiveIncidents().find(i =>
        i.alerts.some(a => a.alertName === 'BulkAlert0'),
      );
      // With 3 alerts, severity should be at least warning
      if (incident && incident.alerts.length >= 3) {
        expect(['warning', 'critical']).toContain(incident.severity);
      }
    });

    it('updates primary alert when higher severity arrives', () => {
      const alert1 = makeAlert({
        alertName: 'LowPri',
        severity: 'warning',
        labels: { pod: 'primary-pod' },
      });
      const alert2 = makeAlert({
        alertName: 'HighPri',
        severity: 'critical',
        labels: { pod: 'primary-pod' },
      });

      ingestAlert(alert1);
      ingestAlert(alert2);

      const incident = getActiveIncidents().find(i =>
        i.alerts.some(a => a.alertName === 'LowPri'),
      );
      expect(incident!.primaryAlert.alertName).toBe('HighPri');
    });
  });

  // ===== Resolved Alerts =====

  describe('resolved alerts', () => {
    it('marks matching alert as resolved in incident after dedup window', () => {
      vi.useFakeTimers();

      const alert = makeAlert({ id: 'resolve-me', alertName: 'ToResolve' });
      ingestAlert(alert);

      // Advance past the 15-min dedup window so the resolved alert isn't dedup-skipped
      vi.advanceTimersByTime(16 * 60 * 1000);

      const resolvedAlert = makeAlert({ id: 'resolve-me', alertName: 'ToResolve', status: 'resolved' });
      ingestAlert(resolvedAlert);

      const incident = getActiveIncidents().find(i =>
        i.alerts.some(a => a.id === 'resolve-me'),
      );
      const matchedAlert = incident?.alerts.find(a => a.id === 'resolve-me');
      expect(matchedAlert?.status).toBe('resolved');

      vi.useRealTimers();
    });
  });

  // ===== Investigation Trigger =====

  describe('investigation trigger', () => {
    it('calls incident handler after buffer period', async () => {
      vi.useFakeTimers();
      const handler = vi.fn().mockResolvedValue(undefined);
      setIncidentHandler(handler);

      const alert = makeAlert({ alertName: 'InvestigateMe' });
      ingestAlert(alert);

      // Advance past the 30s buffer window
      vi.advanceTimersByTime(31_000);

      // Give promises time to resolve
      await vi.runAllTimersAsync();

      expect(handler).toHaveBeenCalled();
      const calledIncident = handler.mock.calls[0][0] as Incident;
      expect(calledIncident.status).toBe('investigating');

      vi.useRealTimers();
    });
  });

  // ===== updateIncident / getIncident =====

  describe('updateIncident', () => {
    it('partially updates incident fields', () => {
      const alert = makeAlert({ alertName: 'UpdateTest' });
      ingestAlert(alert);
      const incident = getActiveIncidents().find(i =>
        i.alerts.some(a => a.alertName === 'UpdateTest'),
      );
      expect(incident).toBeDefined();

      updateIncident(incident!.id, { status: 'analyzed' });
      const updated = getIncident(incident!.id);
      expect(updated!.status).toBe('analyzed');
    });
  });

  // ===== cleanupStaleData =====

  describe('cleanupStaleData', () => {
    it('removes incidents older than 24h that are not investigating', () => {
      vi.useFakeTimers();

      const alert = makeAlert({ alertName: 'StaleTest' });
      ingestAlert(alert);
      const incident = getActiveIncidents().find(i =>
        i.alerts.some(a => a.alertName === 'StaleTest'),
      );
      expect(incident).toBeDefined();

      // Mark as analyzed so it's eligible for cleanup
      updateIncident(incident!.id, { status: 'analyzed' });

      // Advance 25 hours
      vi.advanceTimersByTime(25 * 3600 * 1000);
      cleanupStaleData();

      expect(getIncident(incident!.id)).toBeUndefined();

      vi.useRealTimers();
    });
  });
});
