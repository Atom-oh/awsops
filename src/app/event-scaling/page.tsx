'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Header from '@/components/layout/Header';
import {
  CalendarDays, Plus, RefreshCw, Sparkles, Download, CheckCircle, XCircle,
  Clock, AlertTriangle, ChevronDown, ChevronRight, Trash2, Activity, FileText,
} from 'lucide-react';
import { useAccountContext } from '@/contexts/AccountContext';

type EventStatus = 'planned' | 'analyzing' | 'plan-ready' | 'approved' | 'cancelled';

interface ScalingTarget {
  resourceType: string;
  resourceId: string;
  currentValue: number;
  targetValue: number;
  unit?: string;
  rationale?: string;
  script: string;
}

interface ScalingPhase {
  phaseNumber: number;
  label: string;
  scheduledOffsetMinutes: number;
  targets: ScalingTarget[];
  notes?: string;
}

interface ScalingPlan {
  phases: ScalingPhase[];
  estimatedAdditionalCostUsd?: number;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  generatedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  rawAnalysisMarkdown?: string;
}

interface ReferenceEvent {
  name: string;
  date: string;
  windowMinutes?: number;
  metricsSnapshot?: {
    cloudwatch?: Record<string, { label: string; unit: string; peak?: number; avg?: number }>;
  };
}

interface ScalingEvent {
  eventId: string;
  name: string;
  description?: string;
  eventStart: string;
  eventEnd: string;
  status: EventStatus;
  pattern: {
    type: string;
    expectedPeakMultiplier: number;
    durationMinutes: number;
    rampUpMinutes: number;
    customMetrics?: string[];
  };
  referenceEvents: ReferenceEvent[];
  scalingPlan?: ScalingPlan;
  accountId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

const PATTERN_OPTIONS = [
  { value: 'flash-sale', label: 'Flash Sale (1-2h burst)' },
  { value: 'sustained-peak', label: 'Sustained Peak (multi-hour)' },
  { value: 'gradual-ramp', label: 'Gradual Ramp' },
  { value: 'ticket-drop', label: 'Ticket Drop (seconds-scale)' },
];

const STATUS_STYLES: Record<EventStatus, { bg: string; text: string; label: string }> = {
  planned: { bg: 'bg-navy-600', text: 'text-gray-300', label: 'Planned' },
  analyzing: { bg: 'bg-accent-purple/20', text: 'text-accent-purple', label: 'Analyzing' },
  'plan-ready': { bg: 'bg-accent-cyan/20', text: 'text-accent-cyan', label: 'Plan Ready' },
  approved: { bg: 'bg-accent-green/20', text: 'text-accent-green', label: 'Approved' },
  cancelled: { bg: 'bg-navy-700', text: 'text-gray-500', label: 'Cancelled' },
};

const DEFAULT_FORM = {
  name: '',
  description: '',
  eventStart: '',
  eventEnd: '',
  pattern: {
    type: 'flash-sale',
    expectedPeakMultiplier: 5,
    durationMinutes: 60,
    rampUpMinutes: 30,
    customMetrics: '',
  },
  referenceEventName: '',
  referenceEventDate: '',
};

export default function EventScalingPage() {
  const { currentAccountId } = useAccountContext();
  const [events, setEvents] = useState<ScalingEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [error, setError] = useState<string | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [expandedPhases, setExpandedPhases] = useState<Record<number, boolean>>({});
  const [showRaw, setShowRaw] = useState(false);

  const selected = useMemo(() => events.find(e => e.eventId === selectedId) || null, [events, selectedId]);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const accountQuery = currentAccountId && currentAccountId !== '__all__' ? `&accountId=${currentAccountId}` : '';
      const url = `/awsops/api/event-scaling?action=list${accountQuery}`;
      const res = await fetch(url);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setEvents(data.events || []);
      if (!selectedId && data.events?.length > 0) setSelectedId(data.events[0].eventId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load events');
    } finally {
      setLoading(false);
    }
  }, [currentAccountId, selectedId]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const handleCreate = async () => {
    setSaving(true);
    setError(null);
    try {
      const referenceEvents = form.referenceEventName && form.referenceEventDate
        ? [{ name: form.referenceEventName, date: new Date(form.referenceEventDate).toISOString() }]
        : [];
      const customMetrics = form.pattern.customMetrics
        ? form.pattern.customMetrics.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const res = await fetch('/awsops/api/event-scaling?action=create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          description: form.description,
          eventStart: new Date(form.eventStart).toISOString(),
          eventEnd: new Date(form.eventEnd).toISOString(),
          pattern: {
            type: form.pattern.type,
            expectedPeakMultiplier: Number(form.pattern.expectedPeakMultiplier),
            durationMinutes: Number(form.pattern.durationMinutes),
            rampUpMinutes: Number(form.pattern.rampUpMinutes),
            customMetrics,
          },
          referenceEvents,
          accountId: currentAccountId && currentAccountId !== '__all__' ? currentAccountId : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create');
      setShowForm(false);
      setForm(DEFAULT_FORM);
      setSelectedId(data.event.eventId);
      await loadEvents();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setSaving(false);
    }
  };

  const handleAnalyze = async () => {
    if (!selected) return;
    setAnalyzeError(null);
    setSaving(true);
    try {
      const res = await fetch(`/awsops/api/event-scaling?action=analyze&id=${selected.eventId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang: 'ko' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Analyze failed');
      await loadEvents();
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : 'Analyze failed');
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await fetch(`/awsops/api/event-scaling?action=approve&id=${selected.eventId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Approve failed');
      }
      await loadEvents();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approve failed');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = async (hard = false) => {
    if (!selected) return;
    if (!confirm(hard ? `Hard delete event "${selected.name}"?` : `Cancel event "${selected.name}"?`)) return;
    try {
      const res = await fetch(`/awsops/api/event-scaling?id=${selected.eventId}${hard ? '&hard=true' : ''}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Delete failed');
      }
      if (hard) setSelectedId(null);
      await loadEvents();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const downloadScript = () => {
    if (!selected) return;
    window.location.href = `/awsops/api/event-scaling?action=script&id=${selected.eventId}`;
  };

  const togglePhase = (n: number) => setExpandedPhases(p => ({ ...p, [n]: !p[n] }));

  return (
    <div className="min-h-screen bg-navy-900">
      <Header title="Event Pre-Scaling" subtitle="ADR-010 Phase 1+2" onRefresh={loadEvents} />
      <div className="px-6 py-6 space-y-6">

        {/* Page header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-100 flex items-center gap-2">
              <CalendarDays size={24} className="text-accent-cyan" />
              Event-Driven Pre-Scaling
              <span className="text-xs px-2 py-0.5 rounded bg-navy-700 text-gray-400 font-mono">ADR-010 Phase 1+2</span>
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Register upcoming traffic events, analyze historical metrics, and generate AI-driven warm-up scripts.
              Phase 3 (auto-execute + IAM + KEDA) is deferred to a separate ADR.
            </p>
          </div>
          <button
            onClick={() => setShowForm(s => !s)}
            className="flex items-center gap-2 px-4 py-2 bg-accent-cyan/20 hover:bg-accent-cyan/30 text-accent-cyan border border-accent-cyan/30 rounded transition-colors"
          >
            <Plus size={16} /> New Event
          </button>
        </div>

        {error && (
          <div className="px-4 py-3 bg-accent-red/10 border border-accent-red/30 rounded text-sm text-accent-red flex items-center gap-2">
            <XCircle size={16} /> {error}
          </div>
        )}

        {/* Registration form */}
        {showForm && (
          <div className="bg-navy-800 border border-navy-600 rounded-lg p-5 space-y-4">
            <h2 className="text-lg font-semibold text-gray-100">Register Event</h2>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Name *" value={form.name} onChange={v => setForm({ ...form, name: v })} placeholder="Black Friday 2026" />
              <Field label="Description" value={form.description} onChange={v => setForm({ ...form, description: v })} placeholder="Optional context" />
              <Field label="Event Start *" type="datetime-local" value={form.eventStart} onChange={v => setForm({ ...form, eventStart: v })} />
              <Field label="Event End *" type="datetime-local" value={form.eventEnd} onChange={v => setForm({ ...form, eventEnd: v })} />
              <SelectField
                label="Pattern Type"
                value={form.pattern.type}
                options={PATTERN_OPTIONS}
                onChange={v => setForm({ ...form, pattern: { ...form.pattern, type: v } })}
              />
              <Field
                label="Expected Peak Multiplier (Nx)"
                type="number"
                value={String(form.pattern.expectedPeakMultiplier)}
                onChange={v => setForm({ ...form, pattern: { ...form.pattern, expectedPeakMultiplier: Number(v) } })}
              />
              <Field
                label="Peak Duration (min)"
                type="number"
                value={String(form.pattern.durationMinutes)}
                onChange={v => setForm({ ...form, pattern: { ...form.pattern, durationMinutes: Number(v) } })}
              />
              <Field
                label="Ramp-up Window (min)"
                type="number"
                value={String(form.pattern.rampUpMinutes)}
                onChange={v => setForm({ ...form, pattern: { ...form.pattern, rampUpMinutes: Number(v) } })}
              />
              <Field
                label="Custom Metrics (comma)"
                value={form.pattern.customMetrics}
                onChange={v => setForm({ ...form, pattern: { ...form.pattern, customMetrics: v } })}
                placeholder="kafka.consumer_lag, redis.evictions"
              />
            </div>
            <div className="border-t border-navy-600 pt-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-2">Reference Event (optional — used as historical baseline)</h3>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Reference Name" value={form.referenceEventName} onChange={v => setForm({ ...form, referenceEventName: v })} placeholder="Black Friday 2025" />
                <Field label="Reference Peak Time" type="datetime-local" value={form.referenceEventDate} onChange={v => setForm({ ...form, referenceEventDate: v })} />
              </div>
            </div>
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 text-gray-400 hover:text-gray-200">Cancel</button>
              <button
                disabled={saving || !form.name || !form.eventStart || !form.eventEnd}
                onClick={handleCreate}
                className="px-4 py-2 bg-accent-green/20 hover:bg-accent-green/30 text-accent-green border border-accent-green/30 rounded disabled:opacity-50 flex items-center gap-2"
              >
                <Plus size={14} /> Create
              </button>
            </div>
          </div>
        )}

        {/* Event list + Detail */}
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-4 space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-300 uppercase">Events ({events.length})</h2>
              <button onClick={loadEvents} className="text-gray-500 hover:text-gray-300">
                <RefreshCw size={14} />
              </button>
            </div>
            {events.length === 0 && !loading && (
              <div className="text-sm text-gray-500 px-3 py-4 bg-navy-800 border border-navy-600 rounded">
                No events registered yet.
              </div>
            )}
            <div className="space-y-1">
              {events.map(ev => {
                const style = STATUS_STYLES[ev.status];
                const isSel = ev.eventId === selectedId;
                return (
                  <button
                    key={ev.eventId}
                    onClick={() => setSelectedId(ev.eventId)}
                    className={`w-full text-left px-3 py-2.5 rounded border transition-colors ${
                      isSel
                        ? 'bg-navy-700 border-accent-cyan/40'
                        : 'bg-navy-800 border-navy-600 hover:border-navy-500'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-gray-100 truncate">{ev.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${style.bg} ${style.text}`}>{style.label}</span>
                    </div>
                    <div className="text-xs text-gray-500 flex items-center gap-2">
                      <Clock size={11} />
                      {new Date(ev.eventStart).toLocaleString()} · {ev.pattern.expectedPeakMultiplier}x peak
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="col-span-8">
            {!selected && (
              <div className="bg-navy-800 border border-navy-600 rounded p-8 text-center text-gray-500">
                {loading ? 'Loading…' : 'Select an event to view its scaling plan.'}
              </div>
            )}
            {selected && <EventDetail
              event={selected}
              expandedPhases={expandedPhases}
              showRaw={showRaw}
              setShowRaw={setShowRaw}
              togglePhase={togglePhase}
              onAnalyze={handleAnalyze}
              onApprove={handleApprove}
              onCancel={() => handleCancel(false)}
              onHardDelete={() => handleCancel(true)}
              onDownload={downloadScript}
              saving={saving}
              analyzeError={analyzeError}
            />}
          </div>
        </div>

        <div className="text-xs text-gray-600 px-3 py-2 bg-navy-800/50 border border-navy-700 rounded flex items-start gap-2">
          <AlertTriangle size={14} className="text-accent-orange flex-shrink-0 mt-0.5" />
          <span>
            <strong className="text-gray-400">Phase 2 limitation:</strong> generated scripts are exported for human review only.
            AWSops does not execute infrastructure mutations. Phase 3 (auto-execute + IAM expansion + KEDA) is gated by a separate ADR.
          </span>
        </div>
      </div>
    </div>
  );
}

function EventDetail({
  event,
  expandedPhases,
  togglePhase,
  showRaw,
  setShowRaw,
  onAnalyze,
  onApprove,
  onCancel,
  onHardDelete,
  onDownload,
  saving,
  analyzeError,
}: {
  event: ScalingEvent;
  expandedPhases: Record<number, boolean>;
  togglePhase: (n: number) => void;
  showRaw: boolean;
  setShowRaw: (v: boolean) => void;
  onAnalyze: () => void;
  onApprove: () => void;
  onCancel: () => void;
  onHardDelete: () => void;
  onDownload: () => void;
  saving: boolean;
  analyzeError: string | null;
}) {
  const style = STATUS_STYLES[event.status];
  const plan = event.scalingPlan;

  return (
    <div className="bg-navy-800 border border-navy-600 rounded-lg p-5 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-100 flex items-center gap-2">
            {event.name}
            <span className={`text-xs px-2 py-0.5 rounded ${style.bg} ${style.text}`}>{style.label}</span>
          </h2>
          {event.description && <p className="text-sm text-gray-500 mt-1">{event.description}</p>}
          <div className="text-xs text-gray-500 mt-2 flex items-center gap-3">
            <span>Window: {new Date(event.eventStart).toLocaleString()} → {new Date(event.eventEnd).toLocaleString()}</span>
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Pattern: <span className="text-gray-300">{event.pattern.type}</span> ·
            Peak: <span className="text-gray-300">{event.pattern.expectedPeakMultiplier}x</span> ·
            Duration: <span className="text-gray-300">{event.pattern.durationMinutes}min</span> ·
            Ramp-up: <span className="text-gray-300">{event.pattern.rampUpMinutes}min</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            disabled={event.status === 'cancelled'}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-accent-orange border border-navy-600 rounded disabled:opacity-30"
          >
            Cancel
          </button>
          <button
            onClick={onHardDelete}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-accent-red border border-navy-600 rounded"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* Reference events */}
      {event.referenceEvents.length > 0 && (
        <div className="border-t border-navy-600 pt-3">
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Reference Events</h3>
          {event.referenceEvents.map((ref, i) => (
            <div key={i} className="text-xs px-3 py-2 bg-navy-700/50 rounded border border-navy-600">
              <div className="text-gray-200">{ref.name} — {new Date(ref.date).toLocaleString()}</div>
              {ref.metricsSnapshot?.cloudwatch && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {Object.entries(ref.metricsSnapshot.cloudwatch).slice(0, 8).map(([key, s]) => (
                    <div key={key} className="text-[11px] text-gray-500">
                      <span className="text-gray-400">{s.label}</span>: peak <span className="text-accent-cyan">{s.peak?.toFixed(1) ?? '?'}</span> {s.unit}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Action bar */}
      <div className="flex flex-wrap gap-2 border-t border-navy-600 pt-3">
        <button
          onClick={onAnalyze}
          disabled={saving || event.status === 'cancelled'}
          className="flex items-center gap-2 px-3 py-2 text-sm bg-accent-purple/20 hover:bg-accent-purple/30 text-accent-purple border border-accent-purple/30 rounded disabled:opacity-50"
        >
          <Sparkles size={14} /> {plan ? 'Re-analyze' : 'Analyze + Generate Plan'}
        </button>
        {plan && event.status !== 'approved' && event.status !== 'cancelled' && (
          <button
            onClick={onApprove}
            disabled={saving}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-accent-green/20 hover:bg-accent-green/30 text-accent-green border border-accent-green/30 rounded disabled:opacity-50"
          >
            <CheckCircle size={14} /> Approve Plan
          </button>
        )}
        {plan && (
          <button
            onClick={onDownload}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-accent-cyan/20 hover:bg-accent-cyan/30 text-accent-cyan border border-accent-cyan/30 rounded"
          >
            <Download size={14} /> Download Script
          </button>
        )}
      </div>

      {analyzeError && (
        <div className="text-xs text-accent-red px-3 py-2 bg-accent-red/10 border border-accent-red/30 rounded">
          {analyzeError}
        </div>
      )}

      {/* Plan timeline */}
      {plan && (
        <div className="border-t border-navy-600 pt-3 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
              <Activity size={14} /> Scaling Plan ({plan.phases.length} phases)
            </h3>
            <div className="text-xs text-gray-500">
              {plan.modelId} · {plan.inputTokens || 0} in / {plan.outputTokens || 0} out tokens
              {plan.estimatedAdditionalCostUsd != null && ` · est. +$${plan.estimatedAdditionalCostUsd.toFixed(2)}`}
            </div>
          </div>
          {plan.approvedAt && (
            <div className="text-xs text-accent-green flex items-center gap-1">
              <CheckCircle size={12} /> Approved by {plan.approvedBy} at {new Date(plan.approvedAt).toLocaleString()}
            </div>
          )}
          {plan.phases.map(phase => (
            <PhaseRow key={phase.phaseNumber} phase={phase} expanded={!!expandedPhases[phase.phaseNumber]} onToggle={() => togglePhase(phase.phaseNumber)} />
          ))}

          {plan.rawAnalysisMarkdown && (
            <div className="border-t border-navy-600 pt-3">
              <button
                onClick={() => setShowRaw(!showRaw)}
                className="text-xs text-gray-400 hover:text-accent-cyan flex items-center gap-1"
              >
                <FileText size={12} /> {showRaw ? 'Hide' : 'Show'} AI reasoning, risks, cooldown
              </button>
              {showRaw && (
                <pre className="mt-2 px-3 py-2 bg-navy-900 rounded text-xs text-gray-400 whitespace-pre-wrap max-h-96 overflow-y-auto border border-navy-700">
                  {plan.rawAnalysisMarkdown}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PhaseRow({ phase, expanded, onToggle }: { phase: ScalingPhase; expanded: boolean; onToggle: () => void }) {
  const offset = phase.scheduledOffsetMinutes;
  const sign = offset < 0 ? '-' : '+';
  const absMin = Math.abs(offset);
  const hh = Math.floor(absMin / 60);
  const mm = absMin % 60;
  const offsetLabel = offset === 0 ? 'T' : `T${sign}${hh > 0 ? `${hh}h` : ''}${mm > 0 ? `${mm}m` : ''}`;

  return (
    <div className="bg-navy-700/40 border border-navy-600 rounded">
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2 text-left">
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="text-xs font-mono text-accent-cyan w-12">{offsetLabel}</span>
        <span className="text-sm text-gray-200 flex-1">Phase {phase.phaseNumber}: {phase.label}</span>
        <span className="text-xs text-gray-500">{phase.targets.length} target{phase.targets.length !== 1 ? 's' : ''}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-navy-600">
          {phase.notes && <div className="text-xs text-gray-500 italic mt-2">{phase.notes}</div>}
          {phase.targets.map((t, i) => (
            <div key={i} className="text-xs bg-navy-800 rounded p-2 border border-navy-700">
              <div className="flex items-center justify-between">
                <span className="text-gray-300">
                  <span className="font-mono text-accent-cyan">{t.resourceType}</span> · {t.resourceId}
                </span>
                <span className="text-gray-400">
                  <span className="text-gray-500">{t.currentValue}</span> → <span className="text-accent-green">{t.targetValue}</span> {t.unit || ''}
                </span>
              </div>
              {t.rationale && <div className="text-[11px] text-gray-500 mt-1">{t.rationale}</div>}
              {t.script && (
                <pre className="mt-2 text-[11px] text-gray-400 bg-navy-900 px-2 py-1 rounded overflow-x-auto whitespace-pre-wrap">{t.script}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Form helpers ---
function Field({ label, value, onChange, type = 'text', placeholder }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded text-sm text-gray-100 placeholder-gray-600 focus:border-accent-cyan focus:outline-none"
      />
    </div>
  );
}

function SelectField({ label, value, options, onChange }: {
  label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded text-sm text-gray-100 focus:border-accent-cyan focus:outline-none"
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
