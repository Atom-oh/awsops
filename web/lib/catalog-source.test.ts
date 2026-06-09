// web/lib/catalog-source.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const listMock = vi.fn();
vi.mock('@/lib/catalog', () => ({ listAgentsWithSkills: (...a: unknown[]) => listMock(...a) }));

import { getEnabledCustomAgents, _clearCacheForTests } from './catalog-source';

beforeEach(() => { listMock.mockReset(); _clearCacheForTests(); delete process.env.AURORA_ENDPOINT; });

describe('catalog-source', () => {
  it('returns [] when Aurora is unconfigured (no AURORA_ENDPOINT)', async () => {
    expect(await getEnabledCustomAgents()).toEqual([]);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('returns enabled custom agents from the DB and caches them', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    listMock.mockResolvedValue([
      { name: 'compliance', enabled: true, tier: 'custom', skills: [], routingKeywords: [] },
      { name: 'network', enabled: true, tier: 'builtin', skills: [], routingKeywords: [] },
    ]);
    const a = await getEnabledCustomAgents();
    expect(a.map((x) => x.name)).toEqual(['compliance']); // builtin filtered out
    expect(listMock).toHaveBeenCalledWith({ enabledOnly: true });
    await getEnabledCustomAgents(); // cached
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('returns [] (never throws) on DB error', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    listMock.mockRejectedValue(new Error('down'));
    expect(await getEnabledCustomAgents()).toEqual([]);
  });
});
