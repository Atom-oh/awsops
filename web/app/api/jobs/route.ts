import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Mirror scripts/v2/workers/handlers.py REGISTRY. The dispatcher Lambda re-validates server-side.
const ALLOWED = new Set(['noop', 'noop-heavy']);

let sqs: SQSClient | null = null;
function getSqs(): SQSClient {
  if (!sqs) sqs = new SQSClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
  return sqs;
}

export async function POST(req: NextRequest) {
  const queueUrl = process.env.JOBS_QUEUE_URL;
  if (!queueUrl) {
    return NextResponse.json(
      { status: 'unconfigured', message: 'JOBS_QUEUE_URL not set (workers disabled)' },
      { status: 503 },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: 'invalid JSON body' }, { status: 400 });
  }

  const type = body?.type;
  if (typeof type !== 'string' || !ALLOWED.has(type)) {
    return NextResponse.json(
      { message: `unknown job type; allowed: ${[...ALLOWED].join(', ')}` },
      { status: 400 },
    );
  }
  const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {};
  const dryRun = Boolean(body?.dry_run);
  const idempotencyKey =
    typeof body?.idempotency_key === 'string' && body.idempotency_key ? body.idempotency_key : null;

  const pool = getPool();
  // C6: insert-or-get. ON CONFLICT fires only for a non-null DUPLICATE idempotency_key
  // (NULLs are distinct in the unique index, so keyless jobs always insert a fresh row).
  let jobId: string;
  let status = 'queued';
  const ins = await pool.query(
    `INSERT INTO worker_jobs (job_id, type, payload, dry_run, idempotency_key, status)
     VALUES ($1, $2, $3::jsonb, $4, $5, 'queued')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING job_id`,
    [randomUUID(), type, JSON.stringify(payload), dryRun, idempotencyKey],
  );
  if (ins.rows.length > 0) {
    jobId = ins.rows[0].job_id;
  } else {
    const existing = await pool.query(
      `SELECT job_id, status FROM worker_jobs WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (existing.rows.length === 0) {
      return NextResponse.json({ message: 'idempotency conflict but no existing row' }, { status: 500 });
    }
    jobId = existing.rows[0].job_id;
    status = existing.rows[0].status;
  }

  // Enqueue after the row exists (the worker claims by job_id). Re-send on idempotent replay is
  // safe: the dispatcher dedups via the SFN execution name (== job_id).
  await getSqs().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ job_id: jobId, type, payload, dry_run: dryRun }),
    }),
  );

  return NextResponse.json({ job_id: jobId, status }, { status: 202 });
}
