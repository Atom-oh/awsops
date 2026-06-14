import { describe, it, expect, vi } from 'vitest';
import {
  listReports,
  getReport,
  createReport,
  linkReportJob,
  reportForIdempotencyKey,
  markReportFailed,
} from './diagnosis';

const query = vi.fn(async (sql: string) => {
  if (sql.includes('INSERT INTO diagnosis_reports')) return { rows: [{ id: 7 }] };
  if (sql.includes('JOIN worker_jobs')) return { rows: [{ id: 9 }] };
  if (sql.includes('SELECT')) return { rows: [{ id: 1, tier: 'mid', status: 'succeeded' }] };
  return { rows: [] };
});

vi.mock('./db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...(a as [string, unknown[]])) }) }));

describe('diagnosis queries', () => {
  it('listReports returns rows ordered', async () => {
    const rows = await listReports(10);
    expect(rows[0].id).toBe(1);
  });
  it('getReport returns one or null', async () => {
    const r = await getReport(1);
    expect(r?.tier).toBe('mid');
  });
  it('createReport inserts a NULL-fk running row, links the latest succeeded same-tier parent, and returns id', async () => {
    const id = await createReport('mid', 'u@x.io');
    expect(id).toBe(7);
    const [sql] = query.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain('VALUES (NULL');
    expect(sql).toContain("'running'");
    // [Plan 2] parent_report_id subquery = most-recent succeeded report of the same tier
    expect(sql).toContain('parent_report_id');
    expect(sql).toContain("status = 'succeeded'");
  });
  it('reportForIdempotencyKey returns existing report id or null', async () => {
    const id = await reportForIdempotencyKey('report:u@x.io:mid:2026-06-11T00');
    expect(id).toBe(9);
  });
  it('linkReportJob issues an UPDATE setting worker_job_id', async () => {
    await linkReportJob(7, 'job-1');
    const [sql, args] = query.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain('UPDATE diagnosis_reports SET worker_job_id');
    expect(args).toEqual(['job-1', 7]);
  });
  it('markReportFailed only fails a running row', async () => {
    await markReportFailed(7, 'enqueue failed');
    const [sql, args] = query.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain("status = 'failed'");
    expect(sql).toContain("status = 'running'");
    expect(args).toEqual([7, 'enqueue failed']);
  });
  it('A5: report SELECTs surface the progress column (live per-section status)', async () => {
    await listReports(10);
    const [listSql] = query.mock.calls.at(-1) as [string, unknown[]];
    expect(listSql).toContain('progress');
    await getReport(1);
    const [getSql] = query.mock.calls.at(-1) as [string, unknown[]];
    expect(getSql).toContain('progress');
  });
});
