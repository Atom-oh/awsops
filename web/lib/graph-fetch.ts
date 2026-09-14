// Only typed graph-admission failures are retried. Keep the server's single-read
// guard and auth capacity intact; account changes/unmounts cancel this recovery.
const BUSY_DELAYS = [250, 750, 1500, 5000];

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** At most five attempts within a ten-second recovery window. Never retry auth,
 * query, or untyped service errors, and never turn an unavailable read into empty data. */
export async function fetchGraph(url: string, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Graph read timed out')), 10_000);
  try {
    for (let attempt = 0; ; attempt++) {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await fetch(url, { signal: controller.signal });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (response.status !== 503) return response;
      const body = await response.clone().json().catch(() => null);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (body?.collection?.readStatus !== 'unavailable' || body.collection.readReason !== 'busy') return response;
      if (attempt === BUSY_DELAYS.length) throw new Error('Graph read unavailable: busy');
      await pause(BUSY_DELAYS[attempt], controller.signal);
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
