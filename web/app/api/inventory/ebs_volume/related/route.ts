import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

// EBS volume drill-down (gap-audit L97/L98, v1 parity): per-volume snapshots + attached-EC2
// enrichment, both pure cross-queries over the already-synced Aurora rows — no AWS call.
// Account-scoped: resource ids can collide across synced accounts, and a volume's detail must
// never surface another account's rows.

const VOL_RE = /^vol-[0-9a-f]{8,32}$/;
const INST_RE = /^i-[0-9a-f]{8,32}$/;
const MAX_INSTANCES = 10;
const SNAPSHOT_LIMIT = 20;

export interface RelatedSnapshot {
  snapshotId: string; sizeGb: number | null; encrypted: boolean; startTime: string; state: string;
}
export interface RelatedInstance {
  instanceId: string; name: string; instanceType: string; state: string;
}

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const volumeId = url.searchParams.get('volumeId') ?? '';
  if (!VOL_RE.test(volumeId)) {
    return Response.json({ status: 'error', message: 'invalid volumeId' }, { status: 400 });
  }
  const instParam = url.searchParams.get('instanceIds');
  const instanceIds = instParam ? instParam.split(',').filter(Boolean) : [];
  if (instanceIds.length > MAX_INSTANCES || instanceIds.some((i) => !INST_RE.test(i))) {
    return Response.json({ status: 'error', message: 'invalid instanceIds' }, { status: 400 });
  }
  const accountParam = url.searchParams.get('account') ?? 'self';
  if (accountParam !== 'self' && !/^[0-9]{12}$/.test(accountParam)) {
    return Response.json({ status: 'error', message: 'invalid account' }, { status: 400 });
  }

  const pool = getPool();
  // The two blocks degrade independently — one failing query renders an inline error in its
  // own section, never a dead panel (house rule).
  let snapshots: RelatedSnapshot[] | null = null;
  try {
    const r = await pool.query(
      `SELECT resource_id, data FROM inventory_resources
       WHERE resource_type = 'ebs_snapshot' AND account_id = $1 AND data->>'volume_id' = $2
       ORDER BY data->>'start_time' DESC NULLS LAST LIMIT $3`,
      [accountParam, volumeId, SNAPSHOT_LIMIT],
    );
    snapshots = r.rows.map((row) => {
      const d = (row.data ?? {}) as Record<string, unknown>;
      const size = Number(d.volume_size);
      return {
        snapshotId: String(row.resource_id),
        sizeGb: Number.isFinite(size) ? size : null,
        encrypted: d.encrypted === true || d.encrypted === 'true',
        startTime: typeof d.start_time === 'string' ? d.start_time : '',
        state: typeof d.state === 'string' ? d.state : '',
      };
    });
  } catch { /* snapshots stays null → inline section error */ }

  let instances: RelatedInstance[] | null = null;
  if (instanceIds.length > 0) {
    try {
      const r = await pool.query(
        `SELECT resource_id, data FROM inventory_resources
         WHERE resource_type = 'ec2' AND account_id = $1 AND resource_id = ANY($2)`,
        [accountParam, instanceIds],
      );
      instances = r.rows.map((row) => {
        const d = (row.data ?? {}) as Record<string, unknown>;
        return {
          instanceId: String(row.resource_id),
          name: typeof d.name === 'string' ? d.name : '',
          instanceType: typeof d.instance_type === 'string' ? d.instance_type : '',
          state: typeof d.instance_state === 'string' ? d.instance_state : '',
        };
      });
    } catch { /* instances stays null → inline section error */ }
  } else {
    instances = [];
  }

  return Response.json({ snapshots, instances, snapshotLimit: SNAPSHOT_LIMIT });
}
