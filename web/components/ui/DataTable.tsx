'use client';
import { isValidElement, useMemo, useState } from 'react';
import Card from './Card';
import Badge from './Badge';
import StatePill from './StatePill';

export interface Column {
  key: string;
  label: string;
}

// Keys whose cells render as a StatePill (resource state/status).
const STATE_KEYS = new Set(['state', 'status', 'instance_state', 'cache_cluster_status', 'state_value']);

function renderCell(key: string, value: unknown) {
  // Pre-rendered cell (e.g. a drill-in <Link>) — render as-is, don't stringify.
  if (isValidElement(value)) return value;
  if (typeof value === 'boolean') {
    return (
      <Badge tone={value ? 'positive' : 'neutral'} variant="soft">
        {value ? 'true' : 'false'}
      </Badge>
    );
  }
  const s = value == null ? '' : String(value);
  if (STATE_KEYS.has(key) && s !== '') {
    return <StatePill value={s} />;
  }
  return (
    <span className="block max-w-[280px] truncate" title={s}>
      {s}
    </span>
  );
}

type Dir = 'asc' | 'desc';

// Natural/numeric-aware compare: "123" > "23" (numeric:true), and plain strings
// still sort sensibly. Booleans/null coerce to string. Empty values sort last.
export function compareValues(a: unknown, b: unknown, dir: Dir): number {
  const ea = a == null || a === '';
  const eb = b == null || b === '';
  if (ea && eb) return 0;
  if (ea) return 1; // empties always last, regardless of dir
  if (eb) return -1;
  const cmp = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return dir === 'asc' ? cmp : -cmp;
}

export default function DataTable({
  columns,
  rows,
  onRowClick,
}: {
  columns: Column[];
  rows: Record<string, unknown>[];
  onRowClick?: (row: Record<string, unknown>) => void;
}) {
  const [sort, setSort] = useState<{ key: string; dir: Dir } | null>(null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    return [...rows].sort((ra, rb) => compareValues(ra[sort.key], rb[sort.key], sort.dir));
  }, [rows, sort]);

  const toggleSort = (key: string) =>
    setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  if (rows.length === 0) {
    return (
      <Card padded={false}>
        <div className="py-6 px-3 text-center text-[14px] text-ink-400">데이터 없음</div>
      </Card>
    );
  }
  return (
    <Card padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-[14px]">
          <thead className="sticky top-0 z-10 bg-white">
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    onClick={() => toggleSort(c.key)}
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={`text-left text-[11px] uppercase tracking-[0.04em] font-medium py-2.5 px-3 border-b border-ink-100 cursor-pointer select-none hover:text-ink-600 ${active ? 'text-claude-700' : 'text-ink-400'}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {c.label}
                      <span className="text-[9px] leading-none">{active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, i) => (
              <tr
                key={i}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`border-t border-ink-100 hover:bg-ink-50${onRowClick ? ' cursor-pointer' : ''}`}
              >
                {columns.map((c) => (
                  <td key={c.key} className="py-2.5 px-3 text-ink-800 align-top">
                    {renderCell(c.key, row[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
