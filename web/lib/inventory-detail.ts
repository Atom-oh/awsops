import type { InvType } from './inventory-types';

// Spec-driven, grouped, typed rendering layer for the inventory DetailPanel.
// Pure (no React) so it unit-tests in node env and stays client-safe.

export type DetailKind = 'boolean' | 'state' | 'empty' | 'code' | 'text';
export interface DetailValue { kind: DetailKind; text?: string; bool?: boolean }
export interface DetailItem { key: string; label: string; value: unknown; fmt: DetailValue }
export interface DetailGroup { label: string; items: DetailItem[] }

// Keys whose value is a lifecycle state (rendered as a StatePill). Superset of DataTable's set.
const STATE_KEYS = new Set([
  'state', 'status', 'instance_state', 'cache_cluster_status', 'state_value', 'table_status', 'state_code',
]);

/** Classify a single field value into a render descriptor. */
export function formatDetailValue(key: string, value: unknown): DetailValue {
  if (typeof value === 'boolean') return { kind: 'boolean', bool: value };
  if (value == null || value === '') return { kind: 'empty' };
  if (typeof value === 'object') return { kind: 'code', text: JSON.stringify(value, null, 2) };
  const s = String(value);
  if (STATE_KEYS.has(key) && s !== '') return { kind: 'state', text: s };
  return { kind: 'text', text: s };
}

const VIRTUAL_LABELS: Record<string, string> = { resource_id: 'Resource ID', region: 'Region' };

function labelFor(key: string, spec?: InvType): string {
  return spec?.columns.find((c) => c.key === key)?.label ?? VIRTUAL_LABELS[key] ?? key;
}

/**
 * Group a resource row for the DetailPanel.
 * - With a spec carrying `sections`: ordered labelled sections (only keys present in the
 *   row), then an `Other` group for any leftover keys. Field labels come from the type spec.
 * - Without a spec (or no sections): a single unlabelled group with every field in insertion
 *   order and dt = raw key — byte-for-byte the legacy flat behavior.
 */
export function buildDetailGroups(row: Record<string, unknown>, spec?: InvType): DetailGroup[] {
  const entries = Object.entries(row);
  const mk = (key: string, value: unknown, friendly: boolean): DetailItem => ({
    key, label: friendly ? labelFor(key, spec) : key, value, fmt: formatDetailValue(key, value),
  });

  if (!spec?.sections || spec.sections.length === 0) {
    return [{ label: '', items: entries.map(([k, v]) => mk(k, v, false)) }];
  }

  const present = new Map(entries);
  const used = new Set<string>();
  const groups: DetailGroup[] = [];
  for (const sec of spec.sections) {
    const items: DetailItem[] = [];
    for (const k of sec.keys) {
      if (present.has(k)) { items.push(mk(k, present.get(k), true)); used.add(k); }
    }
    if (items.length) groups.push({ label: sec.label, items });
  }
  const other = entries.filter(([k]) => !used.has(k));
  if (other.length) groups.push({ label: 'Other', items: other.map(([k, v]) => mk(k, v, true)) });
  return groups;
}
