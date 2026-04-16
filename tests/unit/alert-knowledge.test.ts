// Unit tests for alert-knowledge.ts — save, similarity search, statistics
// ADR-009

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'path';
import type { Incident, DiagnosisResult, AlertEvent } from '@/lib/alert-types';

// Shared mock state
const mockStore = new Map<string, string>();
const mockDirs = new Set<string>();

// Mock fs operations
vi.mock('fs', () => ({
  existsSync: vi.fn((path: string) => mockDirs.has(path) || mockStore.has(path)),
  mkdirSync: vi.fn((path: string) => { mockDirs.add(path); }),
  writeFileSync: vi.fn((path: string, data: string) => { mockStore.set(path, data); }),
  readFileSync: vi.fn((path: string) => {
    const content = mockStore.get(path);
    if (!content) throw new Error(`ENOENT: ${path}`);
    return content;
  }),
  readdirSync: vi.fn((path: string) => {
    const prefix = path.endsWith('/') ? path : path + '/';
    const entries = new Set<string>();
    for (const key of mockStore.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first) entries.add(first);
      }
    }
    for (const d of mockDirs) {
      if (d.startsWith(prefix) && d !== path) {
        const rest = d.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first) entries.add(first);
      }
    }
    return Array.from(entries);
  }),
}));

import {
  saveAlertDiagnosis,
  findSimilarIncidents,
  getAlertStats,
} from '@/lib/alert-knowledge';

// --- Test Fixtures ---

function makeAlert(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: 'alert-001',
    source: 'alertmanager',
    alertName: 'HighCPU',
    severity: 'critical',
    status: 'firing',
    message: 'CPU usage high',
    timestamp: '2026-04-16T10:00:00.000Z',
    labels: { service: 'api-server', namespace: 'production', pod: 'api-pod-001' },
    annotations: { summary: 'High CPU' },
    rawPayload: {},
    receivedAt: '2026-04-16T10:00:01.000Z',
    ...overrides,
  };
}

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  const alert = makeAlert();
  return {
    id: 'INC-20260416-abc123',
    status: 'analyzed',
    severity: 'critical',
    alerts: [alert],
    primaryAlert: alert,
    correlationReason: 'initial alert',
    affectedServices: ['api-server'],
    affectedResources: ['api-pod-001'],
    createdAt: '2026-04-16T10:00:00.000Z',
    ...overrides,
  };
}

function makeDiagnosisResult(overrides: Partial<DiagnosisResult> = {}): DiagnosisResult {
  return {
    incidentId: 'INC-20260416-abc123',
    markdown: '## Root Cause\nCPU throttling due to resource limits',
    rootCause: 'CPU throttling due to insufficient resource limits',
    rootCauseCategory: 'capacity',
    confidence: 'high',
    investigationSources: ['cloudwatch', 'prometheus'],
    processingTimeMs: 5200,
    model: 'anthropic.claude-opus-4-20250514',
    inputTokens: 12000,
    outputTokens: 3500,
    ...overrides,
  };
}

describe('alert-knowledge', () => {
  beforeEach(() => {
    mockStore.clear();
    mockDirs.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===== saveAlertDiagnosis =====

  describe('saveAlertDiagnosis', () => {
    it('saves diagnosis record to correct month directory', async () => {
      const incident = makeIncident();
      const result = makeDiagnosisResult();

      await saveAlertDiagnosis(incident, result);

      const expectedPath = join(
        resolve(process.cwd(), 'data/alert-diagnosis'),
        '2026-04',
        'INC-20260416-abc123.json',
      );
      expect(mockStore.has(expectedPath)).toBe(true);
    });

    it('creates the month directory if missing', async () => {
      const incident = makeIncident();
      await saveAlertDiagnosis(incident, makeDiagnosisResult());

      const fs = await import('fs');
      expect(fs.mkdirSync).toHaveBeenCalled();
    });

    it('stores correct record structure', async () => {
      const incident = makeIncident();
      const result = makeDiagnosisResult();
      await saveAlertDiagnosis(incident, result);

      const entries = Array.from(mockStore.entries());
      const [, content] = entries.find(([k]) => k.endsWith('.json'))!;
      const record = JSON.parse(content);

      expect(record.incidentId).toBe('INC-20260416-abc123');
      expect(record.alertNames).toEqual(['HighCPU']);
      expect(record.severity).toBe('critical');
      expect(record.rootCause).toBe('CPU throttling due to insufficient resource limits');
      expect(record.rootCauseCategory).toBe('capacity');
      expect(record.confidence).toBe('high');
      expect(record.processingTimeMs).toBe(5200);
      expect(record.alertCount).toBe(1);
    });

    it('merges labels from multiple alerts', async () => {
      const alert1 = makeAlert({ labels: { service: 'api', region: 'us-east-1' } });
      const alert2 = makeAlert({ id: 'alert-002', labels: { service: 'api', host: 'node-1' } });
      const incident = makeIncident({ alerts: [alert1, alert2] });

      await saveAlertDiagnosis(incident, makeDiagnosisResult());

      const entries = Array.from(mockStore.entries());
      const [, content] = entries.find(([k]) => k.endsWith('.json'))!;
      const record = JSON.parse(content);

      expect(record.labels.service).toBe('api');
      expect(record.labels.region).toBe('us-east-1');
      expect(record.labels.host).toBe('node-1');
    });
  });

  // ===== findSimilarIncidents =====

  describe('findSimilarIncidents', () => {
    function seedRecords(records: Array<{ id: string; alertNames: string[]; services: string[]; labels: Record<string, string>; category?: string; timestamp?: string }>) {
      const baseDir = resolve(process.cwd(), 'data/alert-diagnosis');
      mockDirs.add(baseDir);

      for (const r of records) {
        const ts = r.timestamp || '2026-04-15T10:00:00.000Z';
        const month = ts.slice(0, 7); // "2026-04"
        const monthDir = join(baseDir, month);
        mockDirs.add(monthDir);

        const record = {
          incidentId: r.id,
          timestamp: ts,
          alertNames: r.alertNames,
          severity: 'critical',
          affectedServices: r.services,
          affectedResources: [],
          rootCause: 'test root cause',
          rootCauseCategory: r.category || 'capacity',
          confidence: 'high',
          diagnosisMarkdown: '## test',
          investigationSources: ['prometheus'],
          processingTimeMs: 3000,
          alertCount: r.alertNames.length,
          labels: r.labels,
        };
        mockStore.set(join(monthDir, `${r.id}.json`), JSON.stringify(record));
      }
    }

    it('returns empty array when no records exist', async () => {
      const incident = makeIncident();
      const results = await findSimilarIncidents(incident);
      expect(results).toEqual([]);
    });

    it('scores higher for matching alert names', async () => {
      seedRecords([
        { id: 'INC-1', alertNames: ['HighCPU'], services: [], labels: {} },
        { id: 'INC-2', alertNames: ['DiskFull'], services: [], labels: {} },
      ]);

      const incident = makeIncident(); // has HighCPU alert
      const results = await findSimilarIncidents(incident);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].incidentId).toBe('INC-1'); // same alert name → top score
    });

    it('scores higher for matching services', async () => {
      seedRecords([
        { id: 'INC-A', alertNames: ['OtherAlert'], services: ['api-server'], labels: {} },
        { id: 'INC-B', alertNames: ['OtherAlert'], services: ['cache-server'], labels: {} },
      ]);

      const incident = makeIncident(); // affectedServices: ['api-server']
      const results = await findSimilarIncidents(incident);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].incidentId).toBe('INC-A');
    });

    it('respects maxResults parameter', async () => {
      seedRecords([
        { id: 'INC-1', alertNames: ['HighCPU'], services: ['api-server'], labels: {} },
        { id: 'INC-2', alertNames: ['HighCPU'], services: ['api-server'], labels: {} },
        { id: 'INC-3', alertNames: ['HighCPU'], services: ['api-server'], labels: {} },
      ]);

      const incident = makeIncident();
      const results = await findSimilarIncidents(incident, 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('filters out low-score records (score <= 2)', async () => {
      seedRecords([
        { id: 'INC-NO-MATCH', alertNames: ['UnrelatedAlert'], services: ['other-svc'], labels: { zone: 'different' } },
      ]);

      const incident = makeIncident();
      const results = await findSimilarIncidents(incident);
      // A completely unrelated record should have low score
      expect(results.length).toBe(0);
    });
  });

  // ===== getAlertStats =====

  describe('getAlertStats', () => {
    function seedStatsRecords() {
      const baseDir = resolve(process.cwd(), 'data/alert-diagnosis');
      const monthDir = join(baseDir, '2026-04');
      mockDirs.add(baseDir);
      mockDirs.add(monthDir);

      const records = [
        {
          incidentId: 'INC-1', timestamp: '2026-04-10T10:00:00Z',
          alertNames: ['HighCPU', 'HighMemory'], severity: 'critical',
          affectedServices: ['api-server'], affectedResources: [],
          rootCause: 'capacity issue', rootCauseCategory: 'capacity',
          confidence: 'high', diagnosisMarkdown: '', investigationSources: [],
          processingTimeMs: 4000, alertCount: 2, labels: {},
        },
        {
          incidentId: 'INC-2', timestamp: '2026-04-12T12:00:00Z',
          alertNames: ['HighCPU'], severity: 'warning',
          affectedServices: ['cache-server'], affectedResources: [],
          rootCause: 'config issue', rootCauseCategory: 'configuration',
          confidence: 'medium', diagnosisMarkdown: '', investigationSources: [],
          processingTimeMs: 6000, alertCount: 1, labels: {},
        },
        {
          incidentId: 'INC-3', timestamp: '2026-04-14T08:00:00Z',
          alertNames: ['DiskFull'], severity: 'critical',
          affectedServices: ['api-server', 'db-server'], affectedResources: [],
          rootCause: 'capacity issue', rootCauseCategory: 'capacity',
          confidence: 'high', diagnosisMarkdown: '', investigationSources: [],
          processingTimeMs: 5000, alertCount: 1, labels: {},
        },
      ];

      for (const r of records) {
        mockStore.set(join(monthDir, `${r.incidentId}.json`), JSON.stringify(r));
      }
    }

    it('returns zero stats when no records exist', async () => {
      const stats = await getAlertStats(30);
      expect(stats.totalIncidents).toBe(0);
      expect(stats.dateRange).toBeNull();
    });

    it('counts total incidents', async () => {
      seedStatsRecords();
      const stats = await getAlertStats(30);
      expect(stats.totalIncidents).toBe(3);
    });

    it('breaks down by severity', async () => {
      seedStatsRecords();
      const stats = await getAlertStats(30);
      expect(stats.bySeverity.critical).toBe(2);
      expect(stats.bySeverity.warning).toBe(1);
    });

    it('breaks down by root cause category', async () => {
      seedStatsRecords();
      const stats = await getAlertStats(30);
      expect(stats.byCategory.capacity).toBe(2);
      expect(stats.byCategory.configuration).toBe(1);
    });

    it('calculates top alert names', async () => {
      seedStatsRecords();
      const stats = await getAlertStats(30);
      expect(stats.topAlertNames[0].name).toBe('HighCPU');
      expect(stats.topAlertNames[0].count).toBe(2);
    });

    it('calculates top services', async () => {
      seedStatsRecords();
      const stats = await getAlertStats(30);
      const apiServer = stats.topServices.find(s => s.service === 'api-server');
      expect(apiServer).toBeDefined();
      expect(apiServer!.count).toBe(2);
    });

    it('calculates average processing time', async () => {
      seedStatsRecords();
      const stats = await getAlertStats(30);
      expect(stats.avgProcessingTimeMs).toBe(5000); // (4000+6000+5000)/3
    });

    it('reports correct date range', async () => {
      seedStatsRecords();
      const stats = await getAlertStats(30);
      expect(stats.dateRange).not.toBeNull();
      expect(stats.dateRange!.from).toBe('2026-04-10T10:00:00Z');
      expect(stats.dateRange!.to).toBe('2026-04-14T08:00:00Z');
    });
  });
});
