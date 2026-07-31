import { describe, it, expect, vi, beforeEach } from 'vitest';

const { verifyUser, readSchedule, upsertSchedule } = vi.hoisted(() => ({
  verifyUser: vi.fn(), readSchedule: vi.fn(), upsertSchedule: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({
  verifyUser: (...a: unknown[]) => verifyUser(...a),
  identity: (u: { sub: string; email?: string }) => u.email || u.sub,
}));
vi.mock('@/lib/diagnosis-schedule', () => ({
  readSchedule: (...a: unknown[]) => readSchedule(...a),
  upsertSchedule: (...a: unknown[]) => upsertSchedule(...a),
  SCHEDULE_FREQS: ['weekly', 'biweekly', 'monthly'],
}));

import { GET, PUT } from './route';

const req = (body?: unknown, cookie = 'awsops_token=t') =>
  new Request('http://x/api/diagnosis/schedule', {
    method: body === undefined ? 'GET' : 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => { verifyUser.mockReset(); readSchedule.mockReset(); upsertSchedule.mockReset(); });

describe('GET /api/diagnosis/schedule', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it('returns a disabled default when the user has no schedule', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    readSchedule.mockResolvedValue(null);
    const body = await (await GET(req())).json();
    expect(body.schedule.enabled).toBe(false);
    expect(readSchedule).toHaveBeenCalledWith('u1', 'u1'); // scoped to the caller's sub (== identity when no email)
  });

  it('returns the stored schedule', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    readSchedule.mockResolvedValue({ scheduleType: 'weekly', enabled: true, tier: 'deep', model: null, nextRunAt: 'x', lastRunAt: null });
    const body = await (await GET(req())).json();
    expect(body.schedule).toMatchObject({ scheduleType: 'weekly', enabled: true, tier: 'deep' });
  });
});

describe('PUT /api/diagnosis/schedule', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    expect((await PUT(req({ scheduleType: 'weekly', enabled: true }))).status).toBe(401);
  });

  it('400 on an invalid frequency', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    expect((await PUT(req({ scheduleType: 'hourly', enabled: true }))).status).toBe(400);
    expect(upsertSchedule).not.toHaveBeenCalled();
  });

  it('upserts under the caller sub and returns the schedule (no inline diagnosis)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    upsertSchedule.mockResolvedValue({ scheduleType: 'monthly', enabled: true, tier: 'mid', model: null, nextRunAt: 'n', lastRunAt: null });
    const res = await PUT(req({ scheduleType: 'monthly', enabled: true, tier: 'mid' }));
    expect(res.status).toBe(200);
    expect(upsertSchedule).toHaveBeenCalledWith('u1', expect.objectContaining({ scheduleType: 'monthly', enabled: true, tier: 'mid' }), 'u1');
    expect((await res.json()).schedule.scheduleType).toBe('monthly');
  });

  it('ignores a body-supplied sub (no cross-user write)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    upsertSchedule.mockResolvedValue({ scheduleType: 'weekly', enabled: false, tier: 'mid', model: null, nextRunAt: 'n', lastRunAt: null });
    await PUT(req({ scheduleType: 'weekly', enabled: false, user_sub: 'victim', userSub: 'victim' }));
    expect(upsertSchedule).toHaveBeenCalledWith('u1', expect.anything(), 'u1'); // authed sub, not the body's
  });
});

// PR #195 review round 2 MAJOR: report_schedules.user_sub must store the SAME email-preferring
// identity() used everywhere else for ownership (diagnosis_reports.requested_by, worker_jobs.
// requested_by) — a user with both an email and a sub claim was previously scheduled under sub,
// but GET /api/diagnosis and GET /api/jobs filter by identity() (email-preferring), so their own
// scheduled report/job became invisible to them.
describe('GET/PUT /api/diagnosis/schedule scope by identity() (email-preferring), not raw sub', () => {
  it('GET reads the schedule under the email, not the sub, when both claims are present', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1', email: 'u1@x.io' });
    readSchedule.mockResolvedValue(null);
    await GET(req());
    expect(readSchedule).toHaveBeenCalledWith('u1@x.io', 'u1');
  });

  it('PUT upserts the schedule under the email, not the sub, when both claims are present', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1', email: 'u1@x.io' });
    upsertSchedule.mockResolvedValue({ scheduleType: 'weekly', enabled: true, tier: 'mid', model: null, nextRunAt: 'n', lastRunAt: null });
    await PUT(req({ scheduleType: 'weekly', enabled: true }));
    expect(upsertSchedule).toHaveBeenCalledWith('u1@x.io', expect.anything(), 'u1');
  });
});

// PR #195 round-3 review MAJOR: round-2's identity() switch has no bulk migration for rows created
// before it (no queryable sub->email mapping exists to backfill from) — the route must thread the
// caller's raw sub through as a fallback so lib/diagnosis-schedule.ts can self-heal legacy rows.
describe('GET/PUT thread the raw sub through as a legacy fallback for pre-identity() rows', () => {
  it('GET passes both identity() and the raw sub, even with no email claim', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    readSchedule.mockResolvedValue(null);
    await GET(req());
    expect(readSchedule).toHaveBeenCalledWith('u1', 'u1');
  });

  it('PUT passes both identity() and the raw sub, even with no email claim', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    upsertSchedule.mockResolvedValue({ scheduleType: 'weekly', enabled: true, tier: 'mid', model: null, nextRunAt: 'n', lastRunAt: null });
    await PUT(req({ scheduleType: 'weekly', enabled: true }));
    expect(upsertSchedule).toHaveBeenCalledWith('u1', expect.anything(), 'u1');
  });
});
