// Shared interface for all auto-collect agents
// 모든 auto-collect 에이전트의 공통 인터페이스

export type SendFn = (event: string, data: any) => void;

/**
 * Optional alert-scoped context passed to collectors when invoked by the
 * alert-triggered diagnosis pipeline (ADR-009). Narrows data collection to the
 * specific services/resources/alert names that are firing, so Bedrock analysis
 * isn't diluted by unrelated alarms/events.
 */
export interface AlertContext {
  /** Affected services extracted from alert labels (e.g., "payment", "ingress") */
  services?: string[];
  /** Affected resource identifiers (e.g., "i-0abc123", "pod-xyz", cluster arn) */
  resources?: string[];
  /** Alert names from the correlated incident (e.g., "HighCPU", "Pod-OOMKilled") */
  alertNames?: string[];
  /** K8s namespaces extracted from alert labels */
  namespaces?: string[];
  /** ISO timestamp of earliest alert in the incident — narrows time window */
  since?: string;
}

export interface CollectorResult {
  /** Collected data sections — agent-specific */
  sections: Record<string, any>;
  /** Tools/sources that were successfully used */
  usedTools: string[];
  /** Resources that were queried */
  queriedResources: string[];
  /** Human-readable summary for "via" field */
  viaSummary: string;
}

export interface Collector {
  /**
   * Collect data from multiple sources in parallel.
   * @param alertContext when present, the collector narrows its scope to the
   *   alert's services/resources/namespaces instead of a full environment scan.
   */
  collect(send: SendFn, accountId?: string, isEn?: boolean, alertContext?: AlertContext): Promise<CollectorResult>;
  /** Format collected data as context string for Bedrock */
  formatContext(data: CollectorResult): string;
  /** System prompt for Bedrock analysis */
  analysisPrompt: string;
  /** Display name shown in UI */
  displayName: string;
}
