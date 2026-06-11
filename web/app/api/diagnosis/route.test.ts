import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ verifyUser: vi.fn() }));
vi.mock('@/lib/diagnosis', () => ({
  listReports: vi.fn(async () => [{ id: 1 }]),
  createReport: vi.fn(async () => 42),
  linkReportJob: vi.fn(async () => undefined),
  reportForIdempotencyKey: vi.fn(async () => null),
  markReportFailed: vi.fn(async () => undefined),
}));
vi.mock('@/lib/jobs', () => ({ enqueueJob: vi.fn(async () => ({ job_id: 'j1', status: 'queued' })) }));

import { verifyUser } from '@/lib/auth';
import {
  createReport,
  linkReportJob,
  reportForIdempotencyKey,
  markReportFailed,
} from '@/lib/diagnosis';
import { enqueueJob } from '@/lib/jobs';
import { GET, POST } from './route';

const req = (body?: unknown) =>
  ({ headers: { get: () => 'cookie' }, json: async () => body } as unknown as Request);

beforeEach(() => {
  vi.clearAllMocks();
  // Re-establish default implementations (clearAllMocks wipes call history, not implementations,
  // so a per-test override like mockRejectedValue would otherwise leak into the next test).
  (createReport as any).mockResolvedValue(42);
  (linkReportJob as any).mockResolvedValue(undefined);
  (reportForIdempotencyKey as any).mockResolvedValue(null);
  (markReportFailed as any).mockResolvedValue(undefined);
  (enqueueJob as any).mockResolvedValue({ job_id: 'j1', status: 'queued' });
});

describe('GET /api/diagnosis', () => {
  it('401 when unauthenticated', async () => {
    (verifyUser as any).mockResolvedValue(null);
    const r = await GET(req());
    expect(r.status).toBe(401);
  });
  it('lists when authed', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u', email: 'u@x.io' });
    const r = await GET(req());
    expect(r.status).toBe(200);
    expect((await r.json()).reports[0].id).toBe(1);
  });
});

describe('POST /api/diagnosis', () => {
  it('401 when unauthenticated', async () => {
    (verifyUser as any).mockResolvedValue(null);
    const r = await POST(req({ tier: 'mid' }));
    expect(r.status).toBe(401);
  });

  it('enqueues a mid report (FK-safe order: create → enqueue → link)', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u', email: 'u@x.io' });
    const r = await POST(req({ tier: 'mid' }));
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j.job_id).toBe('j1');
    expect(j.report_id).toBe(42);
    expect(j.tier).toBe('mid');
    // create BEFORE enqueue (FK-safe), with NULL fk; link AFTER enqueue with the canonical job_id.
    expect(createReport).toHaveBeenCalledWith('mid', 'u@x.io');
    expect(enqueueJob).toHaveBeenCalledWith(
      'report',
      expect.objectContaining({ tier: 'mid', requested_by: 'u@x.io', report_id: 42 }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining('report:u@x.io:mid:') }),
    );
    expect(linkReportJob).toHaveBeenCalledWith(42, 'j1');
  });

  it('returns the existing report on idempotency hit (deduped)', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u', email: 'u@x.io' });
    (reportForIdempotencyKey as any).mockResolvedValue(7);
    const r = await POST(req({ tier: 'mid' }));
    expect(r.status).toBe(202);
    expect((await r.json())).toMatchObject({ report_id: 7, deduped: true });
    expect(createReport).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('fails the orphan report row when enqueue throws', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u', email: 'u@x.io' });
    (enqueueJob as any).mockRejectedValue(new Error('boom'));
    await expect(POST(req({ tier: 'mid' }))).rejects.toThrow('boom');
    expect(markReportFailed).toHaveBeenCalledWith(42, 'enqueue failed');
  });

  it('coerces an unknown/deep tier to mid', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u', email: 'u@x.io' });
    await POST(req({ tier: 'deep' }));
    expect(createReport).toHaveBeenCalledWith('mid', 'u@x.io');
  });
});
