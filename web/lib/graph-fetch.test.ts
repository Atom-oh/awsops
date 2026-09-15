import { afterEach, expect, it, vi } from 'vitest';
import { fetchGraph } from './graph-fetch';

afterEach(() => vi.unstubAllGlobals());
const busy = () => Response.json({ collection: { readStatus: 'unavailable', readReason: 'busy' } }, { status: 503 });

it.each([401, 500, 503])('does not retry an untyped/non-busy HTTP %s response', async status => {
  const fetch = vi.fn(async () => Response.json({ message: 'unavailable' }, { status }));
  vi.stubGlobal('fetch', fetch);
  const response = await fetchGraph('/api/graph?class=infra');
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ message: 'unavailable' });
  expect(fetch).toHaveBeenCalledOnce();
});

it('caps persistent busy at five requests and reports unavailable instead of empty', async () => {
  const fetch = vi.fn(async () => busy());
  vi.stubGlobal('fetch', fetch);
  await expect(fetchGraph('/api/graph?class=infra')).rejects.toThrow('Graph read unavailable: busy');
  expect(fetch).toHaveBeenCalledTimes(5);
}, 12_000);

it('cancels a pending retry when the account request is abandoned', async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async () => busy());
  vi.stubGlobal('fetch', fetch);
  const result = fetchGraph('/api/graph?class=infra', controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  setTimeout(() => controller.abort(), 50);
  await rejected;
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(fetch).toHaveBeenCalledOnce();
});

it('aborts a stuck request at the recovery deadline', async () => {
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  })));
  await expect(fetchGraph('/api/graph?class=infra')).rejects.toThrow('Graph read timed out');
}, 12_000);
