// Client-side derived fields per inventory type — flattens JSONB nests / formats raw values
// into table-ready columns (v1 parity: readable MSK/DynamoDB/EBS/ECS-task lists). Pure, no React.

type Row = Record<string, unknown>;

const asObj = (v: unknown): Row | null => {
  if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
    try { v = JSON.parse(v); } catch { return null; }
  }
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : null;
};
const asArr = (v: unknown): unknown[] | null => {
  if (typeof v === 'string' && v.startsWith('[')) {
    try { v = JSON.parse(v); } catch { return null; }
  }
  return Array.isArray(v) ? v : null;
};

/** Case/underscore-insensitive nested lookup (Steampipe JSONB mixes snake_case and PascalCase). */
function walk(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    const o = asObj(cur);
    if (!o) return undefined;
    const want = seg.toLowerCase().replace(/_/g, '');
    const key = Object.keys(o).find((k) => k.toLowerCase().replace(/_/g, '') === want);
    if (key == null) return undefined;
    cur = o[key];
  }
  return cur;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
function bytesH(v: unknown): string | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  if (n <= 0) return '0 B';
  const i = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${BYTE_UNITS[i]}`;
}
function dateH(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 16).replace('T', ' ');
}

const DERIVERS: Record<string, (r: Row) => Row> = {
  msk: (r) => ({
    kafka_version: walk(r.provisioned, 'current_broker_software_info.kafka_version'),
    broker_nodes: walk(r.provisioned, 'number_of_broker_nodes'),
    broker_instance_type: walk(r.provisioned, 'broker_node_group_info.instance_type'),
    broker_ebs_gb: walk(r.provisioned, 'broker_node_group_info.storage_info.ebs_storage_info.volume_size'),
    created_h: dateH(r.creation_time),
  }),
  dynamodb: (r) => ({
    item_count_h: Number.isFinite(Number(r.item_count)) ? Number(r.item_count).toLocaleString() : undefined,
    table_size_h: bytesH(r.table_size_bytes),
    billing_h:
      String(r.billing_mode ?? '').toUpperCase() === 'PAY_PER_REQUEST' ? 'On-Demand'
        : String(r.billing_mode ?? '').toUpperCase() === 'PROVISIONED' ? 'Provisioned'
          : (r.billing_mode as string | undefined),
    created_h: dateH(r.creation_date_time),
  }),
  ebs_volume: (r) => {
    const att = asArr(r.attachments);
    const first = att && att.length > 0 ? asObj(att[0]) : null;
    const inst = first ? (walk(first, 'instance_id') as string | undefined) : undefined;
    return { attached_to: inst ?? 'Unattached' };
  },
  ecs_task: (r) => ({
    task_short: typeof r.resource_id === 'string' ? r.resource_id.split('/').pop()?.slice(0, 12) : undefined,
    cpu_h: Number.isFinite(Number(r.cpu)) ? `${r.cpu} (${(Number(r.cpu) / 1024).toFixed(2)} vCPU)` : undefined,
    memory_h: Number.isFinite(Number(r.memory)) ? `${r.memory} MB (${(Number(r.memory) / 1024).toFixed(1)} GB)` : undefined,
    started_h: dateH(r.started_at),
  }),
};

/** Merge type-specific derived fields into a flattened row (missing sources stay undefined). */
export function deriveRow(type: string, row: Row): Row {
  const fn = DERIVERS[type];
  if (!fn) return row;
  const extra = fn(row);
  for (const k of Object.keys(extra)) if (extra[k] === undefined) delete extra[k];
  return { ...row, ...extra };
}
