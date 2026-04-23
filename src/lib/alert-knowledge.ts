// Alert knowledge base — stores diagnosis records for similarity search
// 알림 지식 베이스 — 진단 기록 저장 및 유사도 검색
// ADR-009

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import type { Incident, DiagnosisResult } from '@/lib/alert-types';

const BASE_DIR = resolve(process.cwd(), 'data/alert-diagnosis');

export interface DiagnosisRecord {
  incidentId: string;
  timestamp: string;
  alertNames: string[];
  severity: string;
  affectedServices: string[];
  affectedResources: string[];
  rootCause: string;
  rootCauseCategory: string;
  confidence: string;
  diagnosisMarkdown: string;
  investigationSources: string[];
  processingTimeMs: number;
  alertCount: number;
  labels: Record<string, string>;  // merged labels from all alerts
}

// --- Save ---

export async function saveAlertDiagnosis(incident: Incident, result: DiagnosisResult): Promise<void> {
  const now = new Date(incident.createdAt);
  const monthDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dir = join(BASE_DIR, monthDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Merge labels from all alerts
  const mergedLabels: Record<string, string> = {};
  for (const alert of incident.alerts) {
    Object.assign(mergedLabels, alert.labels);
  }

  const record: DiagnosisRecord = {
    incidentId: incident.id,
    timestamp: incident.createdAt,
    alertNames: incident.alerts.map(a => a.alertName),
    severity: incident.severity,
    affectedServices: incident.affectedServices,
    affectedResources: incident.affectedResources,
    rootCause: result.rootCause,
    rootCauseCategory: result.rootCauseCategory,
    confidence: result.confidence,
    diagnosisMarkdown: result.markdown,
    investigationSources: result.investigationSources,
    processingTimeMs: result.processingTimeMs,
    alertCount: incident.alerts.length,
    labels: mergedLabels,
  };

  const filePath = join(dir, `${incident.id}.json`);
  writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
  console.log(`[AlertKnowledge] Saved ${incident.id} → ${filePath}`);

  // Opportunistically refresh the monthly summary — cheap file IO, keeps the
  // dashboard/reports in sync without a separate scheduler.
  try {
    await updateMonthlySummary(monthDir);
  } catch (err) {
    console.warn('[AlertKnowledge] Monthly summary update failed:', err instanceof Error ? err.message : err);
  }
}

// --- Monthly Summary ---

export interface MonthlySummary {
  month: string; // "YYYY-MM"
  generatedAt: string;
  totalIncidents: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  byConfidence: Record<string, number>;
  topAlertNames: Array<{ name: string; count: number }>;
  topServices: Array<{ service: string; count: number }>;
  topResources: Array<{ resource: string; count: number }>;
  avgProcessingTimeMs: number;
  mttrSeconds: number | null;
  investigationSources: Record<string, number>;
}

async function updateMonthlySummary(monthDir: string): Promise<void> {
  const dirPath = join(BASE_DIR, monthDir);
  if (!existsSync(dirPath)) return;

  const files = readdirSync(dirPath).filter(f => f.endsWith('.json') && f !== 'summary.json');
  const records: DiagnosisRecord[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(dirPath, file), 'utf-8');
      records.push(JSON.parse(raw));
    } catch { /* skip corrupt */ }
  }

  if (records.length === 0) return;

  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  const nameCounts: Record<string, number> = {};
  const serviceCounts: Record<string, number> = {};
  const resourceCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  let totalTime = 0;

  for (const r of records) {
    bySeverity[r.severity] = (bySeverity[r.severity] || 0) + 1;
    byCategory[r.rootCauseCategory] = (byCategory[r.rootCauseCategory] || 0) + 1;
    byConfidence[r.confidence] = (byConfidence[r.confidence] || 0) + 1;
    totalTime += r.processingTimeMs;
    for (const n of r.alertNames) nameCounts[n] = (nameCounts[n] || 0) + 1;
    for (const s of r.affectedServices) serviceCounts[s] = (serviceCounts[s] || 0) + 1;
    for (const res of r.affectedResources) resourceCounts[res] = (resourceCounts[res] || 0) + 1;
    for (const src of r.investigationSources) sourceCounts[src] = (sourceCounts[src] || 0) + 1;
  }

  const rankTop = <K extends string>(obj: Record<string, number>, key: K, limit = 10): Array<Record<K, string> & { count: number }> =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, limit)
      .map(([k, count]) => ({ [key]: k, count } as Record<K, string> & { count: number }));

  const summary: MonthlySummary = {
    month: monthDir,
    generatedAt: new Date().toISOString(),
    totalIncidents: records.length,
    bySeverity,
    byCategory,
    byConfidence,
    topAlertNames: rankTop(nameCounts, 'name'),
    topServices: rankTop(serviceCounts, 'service'),
    topResources: rankTop(resourceCounts, 'resource'),
    avgProcessingTimeMs: totalTime / records.length,
    mttrSeconds: totalTime > 0 ? totalTime / records.length / 1000 : null,
    investigationSources: sourceCounts,
  };

  const summaryPath = resolve(BASE_DIR, `summary-${monthDir}.json`);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
  console.log(`[AlertKnowledge] Updated monthly summary → ${summaryPath}`);
}

export async function getMonthlySummary(month: string): Promise<MonthlySummary | null> {
  const summaryPath = resolve(BASE_DIR, `summary-${month}.json`);
  if (!existsSync(summaryPath)) return null;
  try {
    return JSON.parse(readFileSync(summaryPath, 'utf-8')) as MonthlySummary;
  } catch {
    return null;
  }
}

export async function listMonthlySummaries(): Promise<MonthlySummary[]> {
  if (!existsSync(BASE_DIR)) return [];
  const files = readdirSync(BASE_DIR)
    .filter(f => /^summary-\d{4}-\d{2}\.json$/.test(f))
    .sort().reverse();
  const out: MonthlySummary[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(readFileSync(join(BASE_DIR, f), 'utf-8')));
    } catch { /* skip corrupt */ }
  }
  return out;
}

// --- Find Similar Incidents ---

export async function findSimilarIncidents(
  incident: Incident,
  maxResults: number = 3,
): Promise<DiagnosisRecord[]> {
  const records = loadRecentRecords(90); // last 90 days
  if (records.length === 0) return [];

  const alertNames = new Set(incident.alerts.map(a => a.alertName));
  const services = new Set(incident.affectedServices);
  const labels = mergeIncidentLabels(incident);

  // Score each past record
  const scored = records.map(record => {
    let score = 0;

    // Exact alert name match (strongest signal)
    const nameOverlap = record.alertNames.filter(n => alertNames.has(n)).length;
    score += nameOverlap * 10;

    // Service overlap
    const serviceOverlap = record.affectedServices.filter(s => services.has(s)).length;
    score += serviceOverlap * 5;

    // Label similarity (Jaccard-like)
    const labelScore = computeLabelSimilarity(labels, record.labels);
    score += labelScore * 3;

    // Same root cause category bonus
    if (record.rootCauseCategory === incident.diagnosisResult?.rootCauseCategory) {
      score += 2;
    }

    // Recency bonus (newer = higher)
    const age = Date.now() - new Date(record.timestamp).getTime();
    const dayAge = age / (24 * 3_600_000);
    score += Math.max(0, 1 - dayAge / 90); // 0-1 bonus for last 90 days

    return { record, score };
  });

  return scored
    .filter(s => s.score > 2) // minimum relevance threshold
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.record);
}

// --- Load Records ---

function loadRecentRecords(daysBack: number): DiagnosisRecord[] {
  if (!existsSync(BASE_DIR)) return [];

  const records: DiagnosisRecord[] = [];
  const cutoff = Date.now() - daysBack * 24 * 3_600_000;

  try {
    const monthDirs = readdirSync(BASE_DIR).filter(d => /^\d{4}-\d{2}$/.test(d)).sort().reverse();

    for (const monthDir of monthDirs.slice(0, 4)) { // last 4 months max
      const dirPath = join(BASE_DIR, monthDir);
      const files = readdirSync(dirPath).filter(f => f.endsWith('.json'));

      for (const file of files) {
        try {
          const raw = readFileSync(join(dirPath, file), 'utf-8');
          const record: DiagnosisRecord = JSON.parse(raw);
          if (new Date(record.timestamp).getTime() >= cutoff) {
            records.push(record);
          }
        } catch { /* skip corrupt files */ }
      }
    }
  } catch { /* base dir may not exist yet */ }

  return records;
}

// --- Statistics ---

export interface AlertStats {
  totalIncidents: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  topAlertNames: Array<{ name: string; count: number }>;
  topServices: Array<{ service: string; count: number }>;
  avgProcessingTimeMs: number;
  dateRange: { from: string; to: string } | null;
}

export async function getAlertStats(daysBack: number = 30): Promise<AlertStats> {
  const records = loadRecentRecords(daysBack);

  const stats: AlertStats = {
    totalIncidents: records.length,
    bySeverity: {},
    byCategory: {},
    topAlertNames: [],
    topServices: [],
    avgProcessingTimeMs: 0,
    dateRange: null,
  };

  if (records.length === 0) return stats;

  // Severity counts
  for (const r of records) {
    stats.bySeverity[r.severity] = (stats.bySeverity[r.severity] || 0) + 1;
    stats.byCategory[r.rootCauseCategory] = (stats.byCategory[r.rootCauseCategory] || 0) + 1;
  }

  // Top alert names
  const nameCounts: Record<string, number> = {};
  for (const r of records) {
    for (const name of r.alertNames) {
      nameCounts[name] = (nameCounts[name] || 0) + 1;
    }
  }
  stats.topAlertNames = Object.entries(nameCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  // Top services
  const serviceCounts: Record<string, number> = {};
  for (const r of records) {
    for (const svc of r.affectedServices) {
      serviceCounts[svc] = (serviceCounts[svc] || 0) + 1;
    }
  }
  stats.topServices = Object.entries(serviceCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([service, count]) => ({ service, count }));

  // Avg processing time
  stats.avgProcessingTimeMs = records.reduce((sum, r) => sum + r.processingTimeMs, 0) / records.length;

  // Date range
  const timestamps = records.map(r => r.timestamp).sort();
  stats.dateRange = { from: timestamps[0], to: timestamps[timestamps.length - 1] };

  return stats;
}

// --- Helpers ---

function mergeIncidentLabels(incident: Incident): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const alert of incident.alerts) {
    Object.assign(merged, alert.labels);
  }
  return merged;
}

function computeLabelSimilarity(a: Record<string, string>, b: Record<string, string>): number {
  const aKeys = Object.keys(a);
  const bKeySet = new Set(Object.keys(b));
  const intersection = aKeys.filter(k => bKeySet.has(k) && a[k] === b[k]);
  const unionSize = new Set([...aKeys, ...Object.keys(b)]).size;
  return unionSize === 0 ? 0 : intersection.length / unionSize;
}
