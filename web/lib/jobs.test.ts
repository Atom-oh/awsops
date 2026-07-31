import { describe, it, expect, vi, beforeEach } from 'vitest';

let insertParams: unknown[] = [];
const sqsBodies: string[] = [];
const queryCalls: Array<{ sql: string; params: unknown[] }> = [];
// When set, the INSERT ... ON CONFLICT reports no row (simulating an idempotency-key collision),
// forcing enqueueJob down the conflict-lookup SELECT path.
let simulateConflict = false;

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    query: async (sql: string, params: unknown[]) => {
      queryCalls.push({ sql, params });
      if (/^INSERT/.test(sql)) {
        insertParams = params;
        if (simulateConflict) return { rows: [] };
        return { rows: [{ job_id: params[0] }] }; // inserted (not a conflict)
      }
      // conflict-lookup SELECT
      return { rows: [{ job_id: 'existing-job', status: 'queued' }] };
    },
  }),
}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    async send(cmd: { input: { MessageBody: string } }) {
      sqsBodies.push(cmd.input.MessageBody);
    }
  },
  SendMessageCommand: class {
    constructor(public input: { MessageBody: string }) {}
  },
}));

import { enqueueJob } from './jobs';

beforeEach(() => {
  insertParams = [];
  sqsBodies.length = 0;
  queryCalls.length = 0;
  simulateConflict = false;
  process.env.JOBS_QUEUE_URL = 'https://sqs.local/q';
  process.env.AWS_REGION = 'ap-northeast-2';
});

describe('enqueueJob — scheduler-provenance hardening', () => {
  it('strips client-supplied `scheduled` from BOTH the ledger row and the SQS message', async () => {
    await enqueueJob('report', { tier: 'mid', scheduled: true, report_id: 7 }, { jobId: 'j1' });

    // worker_jobs INSERT payload is params[2] (job_id, type, payload::jsonb, ...)
    const persisted = JSON.parse(insertParams[2] as string);
    expect(persisted.scheduled).toBeUndefined();
    expect(persisted).toMatchObject({ tier: 'mid', report_id: 7 }); // other fields preserved

    const sqs = JSON.parse(sqsBodies[0]);
    expect(sqs.payload.scheduled).toBeUndefined(); // the worker reads this → must not be forgeable
    expect(sqs.payload).toMatchObject({ tier: 'mid', report_id: 7 });
  });

  it('leaves payloads without `scheduled` unchanged', async () => {
    await enqueueJob('report', { tier: 'deep' }, { jobId: 'j2' });
    expect(JSON.parse(insertParams[2] as string)).toEqual({ tier: 'deep' });
  });
});

// pentest-remediation P0-1: worker_jobs now carries the server-derived requester identity so
// GET /api/jobs and GET /api/jobs/[id] can enforce ownership instead of exposing every job.
describe('enqueueJob — requested_by persistence', () => {
  it('persists opts.requestedBy into the INSERT', async () => {
    await enqueueJob('noop', {}, { jobId: 'j3', requestedBy: 'u@x.io' });
    expect(insertParams).toContain('u@x.io');
  });
  it('defaults to null when requestedBy is omitted (internal-only enqueues)', async () => {
    await enqueueJob('noop', {}, { jobId: 'j4' });
    expect(insertParams.at(-1)).toBeNull();
  });
});

// PR #195 review MAJOR: idempotency keys can be deterministic/guessable (e.g. a diagnosis report
// key derived from the victim's email). Without scoping the conflict-lookup by requester, an
// attacker who knows a victim's email could read the victim's job_id/status and have their own
// payload attached to it via the SQS send.
describe('enqueueJob — idempotency conflict lookup scoped by requester', () => {
  it('scopes the conflict SELECT to idempotency_key AND requested_by (NULL-safe)', async () => {
    simulateConflict = true;
    await enqueueJob('report', {}, { idempotencyKey: 'k1', requestedBy: 'victim@x.io', jobId: 'j5' });
    const select = queryCalls.find((c) => /^SELECT/.test(c.sql));
    expect(select?.sql).toMatch(/requested_by IS NOT DISTINCT FROM \$2/);
    expect(select?.params).toEqual(['k1', 'victim@x.io']);
  });

  it('passes null (not undefined) for internal-only enqueues so IS NOT DISTINCT FROM matches NULL rows', async () => {
    simulateConflict = true;
    await enqueueJob('report', {}, { idempotencyKey: 'k2', jobId: 'j6' });
    const select = queryCalls.find((c) => /^SELECT/.test(c.sql));
    expect(select?.params).toEqual(['k2', null]);
  });
});
