'use client';

import { useState, useEffect, useCallback } from 'react';
import Header from '@/components/layout/Header';
import {
  Bell, Shield, Save, RefreshCw, CheckCircle, XCircle,
  TestTube, Slack, Activity, Clock,
  AlertTriangle, ChevronDown, ChevronRight,
} from 'lucide-react';

interface AlertSourceState {
  enabled: boolean;
  secret: string;
  standbySecret?: string;
  queueUrl?: string;
  region?: string;
}

interface SlackState {
  enabled: boolean;
  method: 'webhook' | 'bot';
  webhookUrl: string;
  botToken: string;
  defaultChannel: string;
  channelMapping: { critical: string; warning: string; info: string };
  threadUpdates: boolean;
}

interface AlertConfigState {
  enabled: boolean;
  correlationWindowSeconds: number;
  deduplicationWindowMinutes: number;
  cooldownMinutes: number;
  maxConcurrentInvestigations: number;
  investigationTimeoutSeconds: number;
  includeChangeDetection: boolean;
  knowledgeBaseEnabled: boolean;
  minimumSeverity: 'critical' | 'warning' | 'info';
}

interface DiagnosisRecord {
  incidentId: string;
  timestamp: string;
  alertNames: string[];
  severity: string;
  affectedServices: string[];
  rootCause: string;
  rootCauseCategory: string;
  confidence: string;
  processingTimeMs: number;
  alertCount: number;
}

interface AlertStats {
  totalIncidents: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  topAlertNames: Array<{ name: string; count: number }>;
  avgProcessingTimeMs: number;
}

const DEFAULT_SOURCES: Record<string, AlertSourceState> = {
  cloudwatch: { enabled: false, secret: '' },
  alertmanager: { enabled: false, secret: '' },
  grafana: { enabled: false, secret: '' },
  sqs: { enabled: false, secret: '', queueUrl: '', region: 'ap-northeast-2' },
  generic: { enabled: false, secret: '' },
};

const DEFAULT_SLACK: SlackState = {
  enabled: false,
  method: 'bot',
  webhookUrl: '',
  botToken: '',
  defaultChannel: '#ops-alerts',
  channelMapping: { critical: '#ops-critical', warning: '#ops-alerts', info: '#ops-general' },
  threadUpdates: true,
};

const DEFAULT_CONFIG: AlertConfigState = {
  enabled: false,
  correlationWindowSeconds: 30,
  deduplicationWindowMinutes: 15,
  cooldownMinutes: 5,
  maxConcurrentInvestigations: 3,
  investigationTimeoutSeconds: 120,
  includeChangeDetection: true,
  knowledgeBaseEnabled: true,
  minimumSeverity: 'warning',
};

const SOURCE_LABELS: Record<string, { label: string; desc: string; icon: string }> = {
  cloudwatch: { label: 'CloudWatch Alarm (SNS)', desc: 'Receives CloudWatch alarms via SNS HTTP subscription', icon: '☁️' },
  alertmanager: { label: 'Prometheus Alertmanager', desc: 'Receives alerts from Alertmanager webhook', icon: '🔥' },
  grafana: { label: 'Grafana Alerting', desc: 'Receives alerts from Grafana webhook contact point', icon: '📊' },
  sqs: { label: 'AWS SQS Queue', desc: 'Polls an SQS queue for alert messages', icon: '📨' },
  generic: { label: 'Generic Webhook', desc: 'Accepts any JSON payload with source, title, severity, message', icon: '🔗' },
};

export default function AlertSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ success: boolean; text: string } | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [testingSlack, setTestingSlack] = useState(false);

  const [sources, setSources] = useState<Record<string, AlertSourceState>>(DEFAULT_SOURCES);
  const [slack, setSlack] = useState<SlackState>(DEFAULT_SLACK);
  const [config, setConfig] = useState<AlertConfigState>(DEFAULT_CONFIG);

  // History section
  const [history, setHistory] = useState<DiagnosisRecord[]>([]);
  const [stats, setStats] = useState<AlertStats | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [expandedIncident, setExpandedIncident] = useState<string | null>(null);

  const webhookUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/awsops/api/alert-webhook`
    : 'https://your-domain/awsops/api/alert-webhook';

  const fetchConfig = useCallback(async () => {
    try {
      // Admin check
      const adminResp = await fetch('/awsops/api/steampipe?action=admin-check');
      const adminData = await adminResp.json();
      if (!adminData.isAdmin) {
        setAccessDenied(true);
        setLoading(false);
        return;
      }

      // Fetch current config
      const configResp = await fetch('/awsops/api/steampipe?action=config');
      const configData = await configResp.json();

      if (configData.alertDiagnosis) {
        const ad = configData.alertDiagnosis;
        setConfig({
          enabled: ad.enabled || false,
          correlationWindowSeconds: ad.correlationWindowSeconds || 30,
          deduplicationWindowMinutes: ad.deduplicationWindowMinutes || 15,
          cooldownMinutes: ad.cooldownMinutes || 5,
          maxConcurrentInvestigations: ad.maxConcurrentInvestigations || 3,
          investigationTimeoutSeconds: ad.investigationTimeoutSeconds || 120,
          includeChangeDetection: ad.includeChangeDetection !== false,
          knowledgeBaseEnabled: ad.knowledgeBaseEnabled !== false,
          minimumSeverity: ad.minimumSeverity || 'warning',
        });
        if (ad.sources) {
          setSources(prev => {
            const merged = { ...prev };
            for (const [key, val] of Object.entries(ad.sources as Record<string, AlertSourceState>)) {
              merged[key] = { ...merged[key], ...val };
            }
            return merged;
          });
        }
      }

      if (configData.slack) {
        const s = configData.slack;
        setSlack({
          enabled: s.enabled || false,
          method: s.method || 'bot',
          webhookUrl: s.webhookUrl || '',
          botToken: s.botToken || '',
          defaultChannel: s.defaultChannel || '#ops-alerts',
          channelMapping: s.channelMapping || DEFAULT_SLACK.channelMapping,
          threadUpdates: s.threadUpdates !== false,
        });
      }

      // Fetch alert history
      try {
        const histResp = await fetch('/awsops/api/alert-webhook');
        const histData = await histResp.json();
        if (histData.recentDiagnoses) setHistory(histData.recentDiagnoses);
        if (histData.stats) setStats(histData.stats);
      } catch { /* history optional */ }
    } catch (err) {
      console.error('Failed to fetch config:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const saveAll = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const resp = await fetch('/awsops/api/steampipe', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save-alert-config',
          alertDiagnosis: { ...config, sources },
          slack,
        }),
      });
      const data = await resp.json();
      if (resp.ok) {
        setMessage({ success: true, text: 'Configuration saved successfully' });
      } else {
        setMessage({ success: false, text: data.error || 'Save failed' });
      }
    } catch (err) {
      setMessage({ success: false, text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  const testSlack = async () => {
    setTestingSlack(true);
    try {
      // Save config first, then test via admin endpoint
      await saveAll();
      const resp = await fetch('/awsops/api/steampipe', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test-slack' }),
      });
      const data = await resp.json();
      setMessage({ success: data.ok !== false, text: data.ok !== false ? 'Slack connection successful!' : `Slack test failed: ${data.error || 'Unknown error'}` });
    } catch (err) {
      setMessage({ success: false, text: err instanceof Error ? err.message : 'Slack test failed' });
    } finally {
      setTestingSlack(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col h-screen bg-navy-900 overflow-hidden">
        <Header title="Alert Diagnosis" subtitle="Configure alert-triggered AI diagnosis" />
        <div className="flex-1 flex items-center justify-center">
          <RefreshCw size={24} className="animate-spin text-gray-500" />
        </div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="flex flex-col h-screen bg-navy-900 overflow-hidden">
        <Header title="Alert Diagnosis" subtitle="Configure alert-triggered AI diagnosis" />
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <Shield size={48} className="text-accent-red" />
          <h2 className="text-xl font-bold text-white">Access Denied</h2>
          <p className="text-gray-400 text-sm">Admin access required. Set <code className="text-accent-cyan font-mono">adminEmails</code> in config.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-navy-900 overflow-hidden">
      <Header title="Alert Diagnosis" subtitle="Configure alert-triggered AI diagnosis" onRefresh={fetchConfig} />
      <div className="flex-1 overflow-y-auto p-6 space-y-6">

        {/* Master Toggle */}
        <div className="bg-navy-800 rounded-xl border border-navy-600 overflow-hidden">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Bell size={20} className="text-accent-cyan" />
              <div>
                <h2 className="text-lg font-semibold text-white">Alert-Triggered AI Diagnosis</h2>
                <p className="text-sm text-gray-400">Automatically investigate alerts from external systems</p>
              </div>
            </div>
            <button
              onClick={() => setConfig(prev => ({ ...prev, enabled: !prev.enabled }))}
              className={`w-12 h-6 rounded-full transition-colors relative ${config.enabled ? 'bg-accent-green' : 'bg-navy-600'}`}
            >
              <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${config.enabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
            </button>
          </div>
        </div>

        {/* Webhook URL */}
        {config.enabled && (
          <div className="bg-navy-800 rounded-xl border border-navy-600 p-5">
            <div className="flex items-center gap-2 mb-3">
              <Activity size={16} className="text-cyan-400" />
              <span className="text-sm font-medium text-white">Webhook Endpoint</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-sm text-accent-cyan font-mono select-all">
                {webhookUrl}
              </code>
              <button
                onClick={() => navigator.clipboard.writeText(webhookUrl)}
                className="px-3 py-2 rounded-lg text-xs bg-navy-700 text-gray-400 hover:text-white transition-colors"
              >
                Copy
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Configure this URL in your Alertmanager/Grafana webhook settings. For CloudWatch, create an SNS HTTP subscription pointing here.
            </p>
          </div>
        )}

        {/* Alert Sources */}
        {config.enabled && (
          <div className="bg-navy-800 rounded-xl border border-navy-600 overflow-hidden">
            <div className="px-6 py-4 border-b border-navy-600">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <AlertTriangle size={18} className="text-orange-400" />
                Alert Sources
              </h2>
              <p className="text-sm text-gray-400 mt-0.5">Enable and configure alert sources</p>
            </div>
            <div className="px-6 py-5 space-y-4">
              {Object.entries(SOURCE_LABELS).map(([key, meta]) => (
                <div key={key} className="bg-navy-900 border border-navy-600 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span>{meta.icon}</span>
                      <span className="text-sm font-medium text-white">{meta.label}</span>
                    </div>
                    <button
                      onClick={() => setSources(prev => ({
                        ...prev,
                        [key]: { ...prev[key], enabled: !prev[key].enabled },
                      }))}
                      className={`w-10 h-5 rounded-full transition-colors relative ${sources[key]?.enabled ? 'bg-accent-green' : 'bg-navy-600'}`}
                    >
                      <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${sources[key]?.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 mb-2">{meta.desc}</p>

                  {sources[key]?.enabled && (
                    <div className="space-y-2 mt-3">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">HMAC Secret — Active (optional)</label>
                        <input
                          type="password"
                          value={sources[key]?.secret || ''}
                          onChange={e => setSources(prev => ({
                            ...prev,
                            [key]: { ...prev[key], secret: e.target.value },
                          }))}
                          placeholder="Primary signing key — leave empty to skip verification"
                          className="w-full bg-navy-700 border border-navy-600 rounded-lg px-3 py-2 text-gray-200 focus:border-cyan-500 focus:outline-none text-sm font-mono placeholder-gray-600"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">HMAC Secret — Standby (rotation)</label>
                        <input
                          type="password"
                          value={sources[key]?.standbySecret || ''}
                          onChange={e => setSources(prev => ({
                            ...prev,
                            [key]: { ...prev[key], standbySecret: e.target.value },
                          }))}
                          placeholder="Optional — accepted during rotation (see ADR-022)"
                          className="w-full bg-navy-700 border border-navy-600 rounded-lg px-3 py-2 text-gray-200 focus:border-cyan-500 focus:outline-none text-sm font-mono placeholder-gray-600"
                        />
                      </div>
                      {key === 'sqs' && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <div>
                            <label className="block text-xs text-gray-500 mb-1">SQS Queue URL</label>
                            <input
                              type="text"
                              value={sources[key]?.queueUrl || ''}
                              onChange={e => setSources(prev => ({
                                ...prev,
                                sqs: { ...prev.sqs, queueUrl: e.target.value },
                              }))}
                              placeholder="https://sqs.ap-northeast-2.amazonaws.com/..."
                              className="w-full bg-navy-700 border border-navy-600 rounded-lg px-3 py-2 text-gray-200 focus:border-cyan-500 focus:outline-none text-sm font-mono placeholder-gray-600"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-gray-500 mb-1">Region</label>
                            <input
                              type="text"
                              value={sources[key]?.region || 'ap-northeast-2'}
                              onChange={e => setSources(prev => ({
                                ...prev,
                                sqs: { ...prev.sqs, region: e.target.value },
                              }))}
                              className="w-full bg-navy-700 border border-navy-600 rounded-lg px-3 py-2 text-gray-200 focus:border-cyan-500 focus:outline-none text-sm font-mono placeholder-gray-600"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Slack Integration */}
        {config.enabled && (
          <div className="bg-navy-800 rounded-xl border border-navy-600 overflow-hidden">
            <div className="px-6 py-4 border-b border-navy-600">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <Slack size={18} className="text-purple-400" />
                Slack Integration
              </h2>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-300">Enable Slack notifications</span>
                <button
                  onClick={() => setSlack(prev => ({ ...prev, enabled: !prev.enabled }))}
                  className={`w-10 h-5 rounded-full transition-colors relative ${slack.enabled ? 'bg-accent-green' : 'bg-navy-600'}`}
                >
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${slack.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              {slack.enabled && (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Method</label>
                      <select
                        value={slack.method}
                        onChange={e => setSlack(prev => ({ ...prev, method: e.target.value as 'webhook' | 'bot' }))}
                        className="w-full bg-navy-700 border border-navy-600 rounded-lg px-3 py-2 text-gray-200 focus:border-cyan-500 focus:outline-none text-sm"
                      >
                        <option value="bot">Bot Token (recommended)</option>
                        <option value="webhook">Incoming Webhook</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">
                        {slack.method === 'bot' ? 'Bot Token' : 'Webhook URL'}
                      </label>
                      <input
                        type="password"
                        value={slack.method === 'bot' ? slack.botToken : slack.webhookUrl}
                        onChange={e => setSlack(prev => ({
                          ...prev,
                          [slack.method === 'bot' ? 'botToken' : 'webhookUrl']: e.target.value,
                        }))}
                        placeholder={slack.method === 'bot' ? 'xoxb-...' : 'https://hooks.slack.com/services/...'}
                        className="w-full bg-navy-700 border border-navy-600 rounded-lg px-3 py-2 text-gray-200 focus:border-cyan-500 focus:outline-none text-sm font-mono placeholder-gray-600"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Default Channel</label>
                    <input
                      type="text"
                      value={slack.defaultChannel}
                      onChange={e => setSlack(prev => ({ ...prev, defaultChannel: e.target.value }))}
                      className="w-full bg-navy-700 border border-navy-600 rounded-lg px-3 py-2 text-gray-200 focus:border-cyan-500 focus:outline-none text-sm font-mono placeholder-gray-600"
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    {(['critical', 'warning', 'info'] as const).map(sev => (
                      <div key={sev}>
                        <label className="block text-xs text-gray-500 mb-1 capitalize">{sev} Channel</label>
                        <input
                          type="text"
                          value={slack.channelMapping[sev]}
                          onChange={e => setSlack(prev => ({
                            ...prev,
                            channelMapping: { ...prev.channelMapping, [sev]: e.target.value },
                          }))}
                          className="w-full bg-navy-700 border border-navy-600 rounded-lg px-3 py-2 text-gray-200 focus:border-cyan-500 focus:outline-none text-sm font-mono placeholder-gray-600"
                        />
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={testSlack}
                      disabled={testingSlack}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500/30 transition-colors disabled:opacity-50"
                    >
                      {testingSlack ? <RefreshCw size={14} className="animate-spin" /> : <TestTube size={14} />}
                      Test Connection
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Investigation Settings (Advanced — collapsed by default) */}
        {config.enabled && (
          <div className="bg-navy-800 rounded-xl border border-navy-600 overflow-hidden">
            <button
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="w-full px-6 py-4 flex items-center justify-between hover:bg-navy-700/50 transition-colors"
            >
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <Clock size={18} className="text-cyan-400" />
                Advanced Settings
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Defaults are recommended for most use cases</span>
                {advancedOpen ? <ChevronDown size={18} className="text-gray-400" /> : <ChevronRight size={18} className="text-gray-400" />}
              </div>
            </button>
            {advancedOpen && <div className="px-6 py-5 space-y-4 border-t border-navy-600">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Minimum Severity</label>
                  <select
                    value={config.minimumSeverity}
                    onChange={e => setConfig(prev => ({ ...prev, minimumSeverity: e.target.value as 'critical' | 'warning' | 'info' }))}
                    className="w-full bg-navy-700 border border-navy-600 rounded-lg px-3 py-2 text-gray-200 focus:border-cyan-500 focus:outline-none text-sm"
                  >
                    <option value="critical">Critical only</option>
                    <option value="warning">Warning + Critical</option>
                    <option value="info">All (Info + Warning + Critical)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Correlation Window (s)</label>
                  <input
                    type="number"
                    value={config.correlationWindowSeconds}
                    onChange={e => setConfig(prev => ({ ...prev, correlationWindowSeconds: parseInt(e.target.value) || 30 }))}
                    min={5} max={120}
                    className="w-full bg-navy-700 border border-navy-600 rounded-lg px-3 py-2 text-gray-200 focus:border-cyan-500 focus:outline-none text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Dedup Window (min)</label>
                  <input
                    type="number"
                    value={config.deduplicationWindowMinutes}
                    onChange={e => setConfig(prev => ({ ...prev, deduplicationWindowMinutes: parseInt(e.target.value) || 15 }))}
                    min={1} max={60}
                    className="w-full bg-navy-700 border border-navy-600 rounded-lg px-3 py-2 text-gray-200 focus:border-cyan-500 focus:outline-none text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Cooldown (min)</label>
                  <input
                    type="number"
                    value={config.cooldownMinutes}
                    onChange={e => setConfig(prev => ({ ...prev, cooldownMinutes: parseInt(e.target.value) || 5 }))}
                    min={1} max={30}
                    className="w-full bg-navy-700 border border-navy-600 rounded-lg px-3 py-2 text-gray-200 focus:border-cyan-500 focus:outline-none text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Max Concurrent</label>
                  <input
                    type="number"
                    value={config.maxConcurrentInvestigations}
                    onChange={e => setConfig(prev => ({ ...prev, maxConcurrentInvestigations: parseInt(e.target.value) || 3 }))}
                    min={1} max={5}
                    className="w-full bg-navy-700 border border-navy-600 rounded-lg px-3 py-2 text-gray-200 focus:border-cyan-500 focus:outline-none text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Investigation Timeout (s)</label>
                  <input
                    type="number"
                    value={config.investigationTimeoutSeconds}
                    onChange={e => setConfig(prev => ({ ...prev, investigationTimeoutSeconds: parseInt(e.target.value) || 120 }))}
                    min={30} max={300}
                    className="w-full bg-navy-700 border border-navy-600 rounded-lg px-3 py-2 text-gray-200 focus:border-cyan-500 focus:outline-none text-sm"
                  />
                </div>
              </div>

              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.includeChangeDetection}
                    onChange={e => setConfig(prev => ({ ...prev, includeChangeDetection: e.target.checked }))}
                    className="rounded border-navy-500 bg-navy-700 text-accent-cyan focus:ring-cyan-500"
                  />
                  Change Detection (CloudTrail + K8s Rollouts)
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.knowledgeBaseEnabled}
                    onChange={e => setConfig(prev => ({ ...prev, knowledgeBaseEnabled: e.target.checked }))}
                    className="rounded border-navy-500 bg-navy-700 text-accent-cyan focus:ring-cyan-500"
                  />
                  Knowledge Base (past incident reference)
                </label>
              </div>
            </div>}
          </div>
        )}

        {/* Save Button — sticky at bottom */}
        <div className="sticky bottom-0 z-10 bg-navy-900/95 backdrop-blur-sm border-t border-navy-700 -mx-6 px-6 py-3 flex items-center gap-3">
          <button
            onClick={saveAll}
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/30 transition-colors disabled:opacity-40"
          >
            {saving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
            Save Configuration
          </button>

          {message && (
            <div className={`px-4 py-2.5 rounded-lg flex items-center gap-2 text-sm ${
              message.success
                ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                : 'bg-red-500/10 text-red-400 border border-red-500/20'
            }`}>
              {message.success ? <CheckCircle size={16} /> : <XCircle size={16} />}
              {message.text}
            </div>
          )}
        </div>

        {/* Alert History */}
        <div className="bg-navy-800 rounded-xl border border-navy-600 overflow-hidden">
          <button
            onClick={() => setHistoryExpanded(!historyExpanded)}
            className="w-full px-6 py-4 flex items-center justify-between hover:bg-navy-700/50 transition-colors"
          >
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <Activity size={18} className="text-green-400" />
              Alert History
              {stats && <span className="text-sm font-normal text-gray-400">({stats.totalIncidents} incidents)</span>}
            </h2>
            {historyExpanded ? <ChevronDown size={18} className="text-gray-400" /> : <ChevronRight size={18} className="text-gray-400" />}
          </button>

          {historyExpanded && (
            <div className="px-6 pb-5 space-y-4">
              {/* Stats Summary */}
              {stats && stats.totalIncidents > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="bg-navy-900 rounded-lg p-3">
                    <div className="text-xs text-gray-500">Total</div>
                    <div className="text-xl font-bold text-white">{stats.totalIncidents}</div>
                  </div>
                  <div className="bg-navy-900 rounded-lg p-3">
                    <div className="text-xs text-gray-500">Critical</div>
                    <div className="text-xl font-bold text-red-400">{stats.bySeverity.critical || 0}</div>
                  </div>
                  <div className="bg-navy-900 rounded-lg p-3">
                    <div className="text-xs text-gray-500">Warning</div>
                    <div className="text-xl font-bold text-orange-400">{stats.bySeverity.warning || 0}</div>
                  </div>
                  <div className="bg-navy-900 rounded-lg p-3">
                    <div className="text-xs text-gray-500">Avg Analysis</div>
                    <div className="text-xl font-bold text-cyan-400">{(stats.avgProcessingTimeMs / 1000).toFixed(1)}s</div>
                  </div>
                </div>
              )}

              {/* Recent Incidents */}
              {history.length > 0 ? (
                <div className="space-y-2">
                  {history.map(record => (
                    <div key={record.incidentId} className="bg-navy-900 border border-navy-600 rounded-lg">
                      <button
                        onClick={() => setExpandedIncident(expandedIncident === record.incidentId ? null : record.incidentId)}
                        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-navy-700/30 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                            record.severity === 'critical' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                            record.severity === 'warning' ? 'bg-orange-500/10 text-orange-400 border-orange-500/20' :
                            'bg-blue-500/10 text-blue-400 border-blue-500/20'
                          }`}>
                            {record.severity}
                          </span>
                          <span className="text-sm text-white">{record.alertNames[0]}</span>
                          {record.alertCount > 1 && (
                            <span className="text-xs text-gray-500">+{record.alertCount - 1} more</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-gray-500">
                            {new Date(record.timestamp).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
                          </span>
                          <span className={`text-xs px-1.5 py-0.5 rounded ${
                            record.confidence === 'high' ? 'bg-green-500/10 text-green-400' :
                            record.confidence === 'medium' ? 'bg-yellow-500/10 text-yellow-400' :
                            'bg-gray-500/10 text-gray-400'
                          }`}>
                            {record.confidence}
                          </span>
                        </div>
                      </button>

                      {expandedIncident === record.incidentId && (
                        <div className="px-4 pb-3 border-t border-navy-700 pt-3 space-y-2">
                          <div className="text-sm text-gray-300"><strong>Root Cause:</strong> {record.rootCause}</div>
                          <div className="text-xs text-gray-500">
                            Category: <code className="text-accent-cyan">{record.rootCauseCategory}</code>
                            {' | '}Services: {record.affectedServices.join(', ') || 'N/A'}
                            {' | '}Analysis: {(record.processingTimeMs / 1000).toFixed(1)}s
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500 text-sm">
                  No alert diagnoses yet. Configure alert sources and enable the feature to start.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
