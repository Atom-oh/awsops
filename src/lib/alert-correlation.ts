// Alert correlation engine — groups related alerts into incidents
// 알림 상관 분석 엔진 — 관련 알림을 인시던트로 그룹화
// ADR-009

import {
  AlertEvent,
  AlertSeverity,
  Incident,
  generateIncidentId,
  extractServices,
  extractResources,
} from '@/lib/alert-types';
import { getAlertDiagnosisConfig } from '@/lib/app-config';

// --- In-memory incident state ---

const activeIncidents: Map<string, Incident> = new Map();
const processedAlertIds: Map<string, number> = new Map(); // alertId → timestamp for dedup
const bufferTimers: Map<string, NodeJS.Timeout> = new Map();

// Callback registered by the diagnosis orchestrator
let onIncidentReady: ((incident: Incident) => Promise<void>) | null = null;

export function setIncidentHandler(handler: (incident: Incident) => Promise<void>): void {
  onIncidentReady = handler;
}

// --- Public API ---

export function ingestAlert(alert: AlertEvent): void {
  const config = getAlertDiagnosisConfig();

  // Severity filter
  const minSeverity = config.minimumSeverity || 'warning';
  if (!meetsMinimumSeverity(alert.severity, minSeverity)) return;

  // Deduplication: skip if same alert ID seen within the window
  const dedupWindow = (config.deduplicationWindowMinutes || 15) * 60_000;
  const lastSeen = processedAlertIds.get(alert.id);
  if (lastSeen && Date.now() - lastSeen < dedupWindow) {
    console.log(`[AlertCorrelation] Dedup skip: ${alert.alertName} (${alert.id})`);
    return;
  }
  processedAlertIds.set(alert.id, Date.now());

  // Handle resolved alerts: update existing incidents
  if (alert.status === 'resolved') {
    handleResolvedAlert(alert);
    return;
  }

  // Try to correlate with an existing buffering/investigating incident
  const matched = findCorrelatedIncident(alert);
  if (matched) {
    addAlertToIncident(matched, alert);
    return;
  }

  // Create new incident with buffering
  createNewIncident(alert, config.correlationWindowSeconds || 30);
}

export function getActiveIncidents(): Incident[] {
  return Array.from(activeIncidents.values());
}

export function getIncident(id: string): Incident | undefined {
  return activeIncidents.get(id);
}

export function updateIncident(id: string, updates: Partial<Incident>): void {
  const incident = activeIncidents.get(id);
  if (incident) {
    Object.assign(incident, updates);
  }
}

// Periodic cleanup of stale data (call from cache-warmer or similar)
export function cleanupStaleData(): void {
  const now = Date.now();

  // Remove old dedup entries (>1 hour)
  Array.from(processedAlertIds.entries()).forEach(([id, ts]) => {
    if (now - ts > 3_600_000) processedAlertIds.delete(id);
  });

  // Archive incidents older than 24 hours
  Array.from(activeIncidents.entries()).forEach(([id, incident]) => {
    const age = now - new Date(incident.createdAt).getTime();
    if (age > 24 * 3_600_000 && incident.status !== 'investigating') {
      activeIncidents.delete(id);
    }
  });
}

// --- Internal Logic ---

function createNewIncident(alert: AlertEvent, bufferSeconds: number): void {
  const incident: Incident = {
    id: generateIncidentId(),
    status: 'buffering',
    severity: alert.severity,
    alerts: [alert],
    primaryAlert: alert,
    correlationReason: 'initial alert',
    affectedServices: extractServices(alert),
    affectedResources: extractResources(alert),
    createdAt: new Date().toISOString(),
  };

  activeIncidents.set(incident.id, incident);
  console.log(`[AlertCorrelation] New incident ${incident.id}: ${alert.alertName} (${alert.severity})`);

  // Buffer for N seconds to collect related alerts before investigation
  const timer = setTimeout(() => {
    bufferTimers.delete(incident.id);
    triggerInvestigation(incident);
  }, bufferSeconds * 1000);
  bufferTimers.set(incident.id, timer);
}

function addAlertToIncident(incident: Incident, alert: AlertEvent): void {
  incident.alerts.push(alert);

  // Merge affected services/resources
  const newServices = extractServices(alert);
  const newResources = extractResources(alert);
  incident.affectedServices = Array.from(new Set([...incident.affectedServices, ...newServices]));
  incident.affectedResources = Array.from(new Set([...incident.affectedResources, ...newResources]));

  // Severity escalation
  incident.severity = escalateSeverity(incident);

  // Update primary alert if new alert is higher severity
  if (severityRank(alert.severity) > severityRank(incident.primaryAlert.severity)) {
    incident.primaryAlert = alert;
  }

  // Update correlation reason
  incident.correlationReason = buildCorrelationReason(incident);

  console.log(`[AlertCorrelation] Alert added to ${incident.id}: ${alert.alertName} (total: ${incident.alerts.length})`);
}

function findCorrelatedIncident(alert: AlertEvent): Incident | null {
  const alertServices = new Set(extractServices(alert));
  const alertResources = new Set(extractResources(alert));
  const alertTime = new Date(alert.timestamp).getTime();

  for (const incident of Array.from(activeIncidents.values())) {
    // Only correlate with buffering or investigating incidents
    if (incident.status !== 'buffering' && incident.status !== 'investigating') continue;

    // Rule 1: Same resource (strongest signal)
    const sharedResources = incident.affectedResources.filter((r: string) => alertResources.has(r));
    if (sharedResources.length > 0) return incident;

    // Rule 2: Same service within time window
    const sharedServices = incident.affectedServices.filter((s: string) => alertServices.has(s));
    if (sharedServices.length > 0) {
      const incidentTime = new Date(incident.primaryAlert.timestamp).getTime();
      const timeDiff = Math.abs(alertTime - incidentTime);
      if (timeDiff < 5 * 60_000) return incident; // 5-minute window for same-service
    }

    // Rule 3: Same namespace (Kubernetes)
    if (alert.labels.namespace && incident.alerts.some((a: AlertEvent) => a.labels.namespace === alert.labels.namespace)) {
      const incidentTime = new Date(incident.primaryAlert.timestamp).getTime();
      if (Math.abs(alertTime - incidentTime) < 3 * 60_000) return incident;
    }

    // Rule 4: Close time window for uncorrelated alerts (possible shared root cause)
    const incidentTime = new Date(incident.primaryAlert.timestamp).getTime();
    if (Math.abs(alertTime - incidentTime) < 2 * 60_000 && incident.status === 'buffering') {
      return incident;
    }
  }

  return null;
}

function handleResolvedAlert(alert: AlertEvent): void {
  for (const incident of Array.from(activeIncidents.values())) {
    const matching = incident.alerts.find(a => a.id === alert.id);
    if (matching) {
      matching.status = 'resolved';
      // Check if all alerts in the incident are resolved
      const allResolved = incident.alerts.every(a => a.status === 'resolved');
      if (allResolved && (incident.status === 'analyzed' || incident.status === 'investigating')) {
        incident.status = 'resolved';
        incident.resolvedAt = new Date().toISOString();
        console.log(`[AlertCorrelation] Incident resolved: ${incident.id}`);
      }
      break;
    }
  }
}

async function triggerInvestigation(incident: Incident): Promise<void> {
  // Check concurrent investigation limit
  const config = getAlertDiagnosisConfig();
  const maxConcurrent = config.maxConcurrentInvestigations || 3;
  const currentInvestigations = Array.from(activeIncidents.values())
    .filter(i => i.status === 'investigating').length;

  if (currentInvestigations >= maxConcurrent) {
    console.log(`[AlertCorrelation] Max concurrent investigations (${maxConcurrent}) reached, queuing ${incident.id}`);
    // Retry after cooldown
    const cooldown = (config.cooldownMinutes || 5) * 60_000;
    setTimeout(() => triggerInvestigation(incident), cooldown);
    return;
  }

  incident.status = 'investigating';
  console.log(`[AlertCorrelation] Investigation triggered for ${incident.id} (${incident.alerts.length} alerts, ${incident.severity})`);

  if (onIncidentReady) {
    try {
      await onIncidentReady(incident);
    } catch (err) {
      console.error(`[AlertCorrelation] Investigation failed for ${incident.id}:`, err instanceof Error ? err.message : err);
    }
  }
}

// --- Severity Utilities ---

function severityRank(s: AlertSeverity): number {
  return s === 'critical' ? 3 : s === 'warning' ? 2 : 1;
}

function meetsMinimumSeverity(severity: AlertSeverity, minimum: AlertSeverity): boolean {
  return severityRank(severity) >= severityRank(minimum);
}

function escalateSeverity(incident: Incident): AlertSeverity {
  // Any critical alert → critical
  if (incident.alerts.some(a => a.severity === 'critical')) return 'critical';
  // 3+ alerts → at least warning
  if (incident.alerts.length >= 3) return 'warning';
  // Max severity from all alerts
  return incident.alerts.reduce((max, a) =>
    severityRank(a.severity) > severityRank(max) ? a.severity : max,
    'info' as AlertSeverity
  );
}

function buildCorrelationReason(incident: Incident): string {
  if (incident.alerts.length === 1) return 'initial alert';
  const sources = Array.from(new Set(incident.alerts.map(a => a.source)));
  const services = incident.affectedServices.slice(0, 3);
  const parts: string[] = [];
  parts.push(`${incident.alerts.length} correlated alerts`);
  if (services.length > 0) parts.push(`services: ${services.join(', ')}`);
  if (sources.length > 1) parts.push(`sources: ${sources.join(', ')}`);
  return parts.join(' | ');
}
