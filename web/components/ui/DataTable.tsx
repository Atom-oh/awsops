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

export default function DataTable({ columns, rows }: { columns: Column[]; rows: Record<string, unknown>[] }) {
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
              {columns.map((c) => (
                <th
                  key={c.key}
                  className="text-left text-[11px] uppercase tracking-[0.04em] text-ink-400 font-medium py-2.5 px-3 border-b border-ink-100"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-ink-100 hover:bg-ink-50">
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
