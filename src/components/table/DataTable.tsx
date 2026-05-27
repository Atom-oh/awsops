'use client';

import { useState, useMemo } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { useAccountContext } from '@/contexts/AccountContext';
import AccountBadge from '@/components/dashboard/AccountBadge';

interface Column {
  key: string;
  label: string;
  render?: (value: any, row: any) => React.ReactNode;
}

interface DataTableProps {
  columns: Column[];
  data?: any[];
  onRowClick?: (row: any) => void;
}

const UNIT_MULTIPLIERS: Record<string, number> = {
  '': 1,
  '%': 1,
  k: 1e3, ki: 1024, kb: 1e3, kib: 1024,
  m: 1e6, mi: 1024 ** 2, mb: 1e6, mib: 1024 ** 2,
  g: 1e9, gi: 1024 ** 3, gb: 1e9, gib: 1024 ** 3,
  t: 1e12, ti: 1024 ** 4, tb: 1e12, tib: 1024 ** 4,
  p: 1e15, pi: 1024 ** 5, pb: 1e15, pib: 1024 ** 5,
  b: 1, bytes: 1,
  vcpu: 1, cpu: 1, core: 1, cores: 1,
  ms: 1, s: 1, sec: 1,
};

// Coerce raw cell values into a sortable number. Returns null when the value
// is not numeric so callers can fall back to string comparison. Handles:
//   - JS numbers
//   - pg BIGINT/NUMERIC strings ("1024")
//   - currency / thousand separators ("$1,234.56")
//   - unit-suffixed sizes ("123Ki", "1.5 GiB", "50%", "2 vCPU")
function toSortableNumber(v: any): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed === '') return null;
  const match = trimmed.match(/^-?\s*\$?\s*([\d,]+(?:\.\d+)?)\s*([a-zA-Z%]+)?$/);
  if (!match) return null;
  const n = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = (match[2] ?? '').toLowerCase();
  const mult = UNIT_MULTIPLIERS[unit];
  if (mult === undefined) return null;
  const sign = trimmed.startsWith('-') ? -1 : 1;
  return sign * n * mult;
}

export default function DataTable({ columns, data, onRowClick }: DataTableProps) {
  const { isMultiAccount } = useAccountContext();
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const effectiveColumns = useMemo(() => {
    if (!isMultiAccount || !data?.length || !data[0]?.account_id) return columns;
    const accountCol: Column = {
      key: 'account_id',
      label: 'Account',
      render: (value: string) => <AccountBadge accountId={value} />,
    };
    return [accountCol, ...columns];
  }, [columns, data, isMultiAccount]);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sortedData = (() => {
    if (!data || !sortKey) return data;
    return [...data].sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      const aNum = toSortableNumber(aVal);
      const bNum = toSortableNumber(bVal);
      if (aNum !== null && bNum !== null) {
        return sortDir === 'asc' ? aNum - bNum : bNum - aNum;
      }
      const cmp = String(aVal).localeCompare(String(bVal));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  })();

  // Loading skeleton
  if (!data) {
    return (
      <div className="bg-navy-800 rounded-lg border border-navy-600 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-navy-700">
                {effectiveColumns.map((col) => (
                  <th
                    key={col.key}
                    className="px-4 py-3 text-left text-xs font-mono font-semibold uppercase tracking-wider text-accent-cyan"
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-navy-600">
                  {effectiveColumns.map((col) => (
                    <td key={col.key} className="px-4 py-3">
                      <div className="h-4 bg-navy-700 rounded animate-pulse w-3/4" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Empty state
  if (data.length === 0) {
    return (
      <div className="bg-navy-800 rounded-lg border border-navy-600 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-navy-700">
                {effectiveColumns.map((col) => (
                  <th
                    key={col.key}
                    className="px-4 py-3 text-left text-xs font-mono font-semibold uppercase tracking-wider text-accent-cyan"
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
          </table>
        </div>
        <div className="py-12 text-center text-gray-500 text-sm">
          No resources found
        </div>
      </div>
    );
  }

  return (
    <div className="bg-navy-800 rounded-lg border border-navy-600 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-navy-700">
              {effectiveColumns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key)}
                  className="px-4 py-3 text-left text-xs font-mono font-semibold uppercase tracking-wider text-accent-cyan cursor-pointer select-none hover:text-white transition-colors"
                >
                  <div className="flex items-center gap-1">
                    {col.label}
                    {sortKey === col.key && (
                      sortDir === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedData?.map((row, i) => (
              <tr
                key={i}
                onClick={() => onRowClick?.(row)}
                className={`border-b border-navy-600 transition-colors hover:bg-navy-700 ${
                  onRowClick ? 'cursor-pointer' : ''
                }`}
              >
                {effectiveColumns.map((col) => (
                  <td key={col.key} className="px-4 py-3 text-sm text-gray-300">
                    {col.render ? col.render(row[col.key], row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
