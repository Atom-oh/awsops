// Bounded JSON body reader. App-Router route handlers impose NO default request-body cap, so a plain
// `await request.json()` buffers+parses an arbitrarily large body into the heap BEFORE any field-length
// check runs — an authenticated user could OOM a memory-constrained Fargate task. This caps bytes
// BEFORE parse: a fast Content-Length reject + a streamed byte accumulator that aborts past the cap
// (so an absent/lying Content-Length cannot bypass it).

export class BodyTooLargeError extends Error {
  constructor(message = 'request body too large') {
    super(message);
    this.name = 'BodyTooLargeError';
  }
}

/** Read + parse a JSON body, rejecting bodies larger than maxBytes before fully materializing them. */
export async function readJsonBounded(request: Request, maxBytes = 65_536): Promise<unknown> {
  const len = request.headers.get('content-length');
  if (len && Number.isFinite(Number(len)) && Number(len) > maxBytes) {
    throw new BodyTooLargeError();
  }
  const stream = request.body;
  let text: string;
  if (!stream) {
    text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new BodyTooLargeError();
  } else {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* best-effort */ }
          throw new BodyTooLargeError();
        }
        chunks.push(value);
      }
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    text = new TextDecoder().decode(buf);
  }
  return text ? JSON.parse(text) : {};
}
