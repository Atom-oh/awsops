import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { PoolClient } from 'pg';
import { getPool } from './db';

export interface User {
  sub: string;
  email?: string;
  groups?: string[];
  iat?: number;
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) {
    const region = process.env.AWS_REGION || 'ap-northeast-2';
    const pool = process.env.COGNITO_USER_POOL_ID;
    jwks = createRemoteJWKSet(
      new URL(`https://cognito-idp.${region}.amazonaws.com/${pool}/.well-known/jwks.json`),
    );
  }
  return jwks;
}

// pentest-remediation P1-1 (Finding 1): Cognito's id_token has no server-side revocation
// (GlobalSignOut only reaches refresh/access tokens), so logout was purely a client-side cookie
// clear — a captured pre-logout token stayed valid for its full remaining ~12h. This is our own
// revocation store: one row per user (sub), stamped by signout() below. Fails OPEN on a DB error —
// a transient Aurora blip must not log every user in the app out; it just means revocation isn't
// enforced during that window, which is the pre-fix status quo, not a new failure domain.
// pentest-remediation P1-review (MAJOR-3): every authenticated request now costs an Aurora
// round-trip. A hung query (cold-start ACU scaling, exhausted `max: 3` pool) would previously
// stall forever — a rejected promise fails open via the catch below, but a promise that never
// settles doesn't. Race it against a short timer so "hung" degrades the same way "errored" does.
const REVOCATION_CHECK_TIMEOUT_MS = 3000;

// pentest-remediation P3-review (MAJOR-2): Promise.race above only stops *us* from waiting on a
// hung query — the query itself keeps running server-side and keeps holding its connection out of
// the `max: 3` pool. 3 concurrent hangs (e.g. an Aurora Serverless v2 scaling event) would then
// starve the whole app's pool, not just auth. `SET LOCAL statement_timeout` makes Postgres itself
// cancel the statement, freeing the connection. Scoped to this one query via a throwaway
// transaction (`SET LOCAL` reverts at COMMIT/ROLLBACK) so it never leaks onto other queries that
// share this same pooled connection afterward — a pool-wide `options: '-c statement_timeout=...'`
// would also throttle unrelated longer-running queries elsewhere in the app.
// pentest-remediation P4-review (MAJOR): this used to be READ-path-only (queryRevocation), leaving
// the WRITE path (revokeSessionsFor) with a raw, un-timeout-bounded pool.query — a hung UPSERT
// could hold a connection forever, and since /api/auth/signout is a PUBLIC route with only
// `max: 3` connections in the pool, a handful of concurrent hung signouts could exhaust the pool
// and take isRevoked() (and thus every authenticated request) down with it. Both callers now share
// this one helper so they can never drift apart again.
if (!Number.isInteger(REVOCATION_CHECK_TIMEOUT_MS)) {
  // `SET LOCAL statement_timeout = ${...}` is string-interpolated (SET LOCAL can't take a bound
  // parameter), so this constant must stay a literal integer — guard against it silently becoming
  // an injection point if it's ever moved to an env var.
  throw new Error('REVOCATION_CHECK_TIMEOUT_MS must be an integer');
}

type TimeoutRaceState = { client: PoolClient | null; released: boolean; cancelled: boolean };

async function runInTimeoutScopedTransaction<T>(
  runQuery: (client: PoolClient) => Promise<T>,
  state: TimeoutRaceState,
): Promise<T> {
  const client = await getPool().connect();
  state.client = client;
  // pentest-remediation P6-review (MAJOR): the timer may have fired while we were still waiting on
  // connect() — at that point `state.client` was still null, so the timer had no connection to
  // destroy and could only set `cancelled`. Without this check we'd go on to spend a full
  // BEGIN/SET LOCAL/query/COMMIT round-trip on a connection nobody is waiting for any more. That's
  // the pathological case under pool saturation: the 3s timer beats db.ts's 5s
  // connectionTimeoutMillis, so EVERY saturated request would take this path and the abandoned
  // work would keep the `max: 3` pool starved — load-shedding inverted into positive feedback,
  // silently disabling revocation app-wide via isRevoked's fail-open. Hand the connection straight
  // back instead and do no work on it.
  if (state.cancelled) {
    if (!state.released) {
      state.released = true;
      client.release();
    }
    throw new Error('revocation query cancelled before it acquired a connection');
  }
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${REVOCATION_CHECK_TIMEOUT_MS}`);
    const result = await runQuery(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {}); // best-effort — connection may already be dead
    throw e;
  } finally {
    // pentest-remediation P5-review (MAJOR M2): if the timer below already destroyed this
    // connection (we lost the race), don't also call the normal release() path here — `state`
    // is shared so whichever side settles first "wins" the connection's disposition.
    if (!state.released) {
      state.released = true;
      client.release();
    }
  }
}

/** Race any pooled query against a client-side timer AND a server-side `SET LOCAL
 * statement_timeout` (see comment above) — the client-side race alone doesn't free a connection
 * still stuck server-side; the timeout alone doesn't help if the connection can't even be
 * acquired from the pool. Both isRevoked (read) and revokeSessionsFor (write) go through this.
 * `T` is inferred from `runQuery`'s own return type — do NOT pass an explicit type argument at the
 * call site (pentest-remediation P5-review CRITICAL: an earlier round pinned T to a row shape like
 * `{ revoked_at: string }` while `runQuery` actually returns `QueryResult<...>`, a structural
 * mismatch `next build`'s `strict` type-check correctly rejects — `vitest` doesn't type-check, so
 * this broke the production build silently past this file's own tests). */
async function withStatementTimeout<T>(runQuery: (client: PoolClient) => Promise<T>): Promise<T> {
  const state: TimeoutRaceState = { client: null, released: false, cancelled: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Always record the cancellation, even when no connection has been checked out yet — a
        // still-pending connect() has nothing to destroy here, but runInTimeoutScopedTransaction
        // needs to know not to start work once it finally does get one (pentest-remediation
        // P6-review MAJOR; see the check there).
        state.cancelled = true;
        // Lost the race — destroy (not release) the connection instead of returning it healthy to
        // the pool: BEGIN/SET LOCAL/the query itself may still be in flight on a socket we've
        // stopped waiting on, and handing back a connection whose transaction state is unknown
        // would corrupt whatever the next borrower does with it (pentest-remediation P5-review
        // MAJOR M2 — `client.release()`'s normal path never runs until the stuck query itself
        // settles, which may be never; `release(true)` drops the connection from the pool now).
        if (state.client && !state.released) {
          state.released = true;
          state.client.release(true);
        }
        reject(new Error('statement timed out'));
      }, REVOCATION_CHECK_TIMEOUT_MS);
    });
    return await Promise.race([runInTimeoutScopedTransaction(runQuery, state), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function isRevoked(sub: string, iat: number | undefined): Promise<boolean> {
  if (!iat) return true; // malformed token (no iat) — fail closed, this one input we don't trust
  try {
    const { rows } = await withStatementTimeout((client) =>
      client.query<{ revoked_at: string }>('SELECT revoked_at FROM session_revocations WHERE user_sub = $1', [sub]),
    );
    if (rows.length === 0) return false;
    const revokedAtSec = new Date(rows[0].revoked_at).getTime() / 1000;
    // `<=`, not strict `<`: revokeSessionsFor stores the signing-out token's OWN iat as the
    // cutoff. With strict `<`, that exact token's own check evaluates `iat < iat` -> false, i.e.
    // the very token just used to log out is judged NOT revoked and stays valid for its full
    // remaining lifetime — defeating the point of this whole mechanism (pentest-remediation
    // P3-review CRITICAL). `<=` closes that. A same-second re-login lands on a token with the
    // same or a later `iat`, so in the pathological same-`iat` case the rejected token itself
    // never "heals" (iat is fixed at issuance — it can't advance on its own). Recovery is via
    // re-login: the rejected verifyUser() sends the edge redirect to /login, and authenticating
    // again mints a genuinely later iat that passes (pentest-remediation P4-review MINOR — this
    // used to describe it as self-healing "the next request once time advances a second", which
    // is wrong; a same-iat token stays rejected for its entire remaining lifetime, not one request).
    return iat <= revokedAtSec;
  } catch (e) {
    // fail open — see comment above the timeout constant / module comment
    console.warn(JSON.stringify({ evt: 'revocation_check_failed', sub, err: e instanceof Error ? e.message : String(e) }));
    return false;
  }
}

/** Record that `sub`'s sessions issued up to now are no longer valid. Called by POST
 * /api/auth/signout with the signed-out token's own `iat` (epoch seconds). Idempotent (upsert) —
 * but the cutoff only advances if `iat` is newer than what's already recorded.
 * pentest-remediation P2-review (MAJOR-1): without the `iat` bound, replaying an already-revoked
 * (but not-yet-expired) token against the public signout route kept pushing `revoked_at` to
 * `now()` on every call — a rolling forced-logout DoS on any session the victim created *after*
 * their first real logout, for as long as the stolen token stays unexpired (up to ~12h). Capping
 * the cutoff at this token's own `iat` means a replay can never invalidate a session issued after
 * the legitimate revocation.
 * pentest-remediation P4-review (MAJOR): now goes through withStatementTimeout like isRevoked
 * (see comment there) instead of a raw getPool().query — the caller (POST /api/auth/signout)
 * already wraps this call in a try/catch that clears the cookie and redirects regardless, so a
 * thrown timeout here degrades exactly like any other write failure: best-effort, fail-open. */
// pentest-remediation P5-review (MAJOR M3): /api/auth/signout is public and has no rate limit — a
// single valid token (an attacker's own, or a stolen-but-live one) replayed in a tight parallel
// loop drives repeated connect→BEGIN→SET LOCAL→UPSERT→COMMIT round-trips through the `max: 3`
// pool. Once the pool is saturated, isRevoked() for every OTHER user's request starts timing out
// too, and its fail-open path means the revocation control this whole PR adds gets silently
// disabled for everyone, not just the attacker's own account. The UPSERT's WHERE guard already
// makes a same-or-older-iat replay a costless no-op *at the database*, so the fix is simply to
// stop paying for the round-trip at all when we've already written for this sub very recently —
// legitimate signout only ever needs to land once. Self-cleaning: each entry removes itself after
// the debounce window, so this can't grow unbounded across the life of a long-running container.
// Keyed by (sub, iat) rather than sub alone: the actual replay attack resends the SAME captured
// token (same iat) — a legitimately *different* token from the same sub (a fresh signout with a
// newer iat) must still write through, since only the exact-token replay is a costless no-op.
const RECENT_REVOKE_DEBOUNCE_MS = 2000;
const recentRevokeWriteAt = new Map<string, number>();

export async function revokeSessionsFor(sub: string, iat: number): Promise<void> {
  const key = `${sub}:${iat}`;
  const now = Date.now();
  const last = recentRevokeWriteAt.get(key);
  if (last !== undefined && now - last < RECENT_REVOKE_DEBOUNCE_MS) return;
  recentRevokeWriteAt.set(key, now);
  setTimeout(() => {
    if (recentRevokeWriteAt.get(key) === now) recentRevokeWriteAt.delete(key);
  }, RECENT_REVOKE_DEBOUNCE_MS);
  await withStatementTimeout((client) =>
    client.query(
      `INSERT INTO session_revocations (user_sub, revoked_at) VALUES ($1, to_timestamp($2))
       ON CONFLICT (user_sub) DO UPDATE SET revoked_at = to_timestamp($2)
       WHERE session_revocations.revoked_at < to_timestamp($2)`,
      [sub, iat],
    ),
  );
}

/** Re-verify the edge-set Cognito id_token (awsops_token cookie). Returns the user or null. */
export async function verifyUser(cookieHeader: string | null): Promise<User | null> {
  const token = parseCookie(cookieHeader, 'awsops_token');
  if (!token) return null;
  const region = process.env.AWS_REGION || 'ap-northeast-2';
  const pool = process.env.COGNITO_USER_POOL_ID;
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: `https://cognito-idp.${region}.amazonaws.com/${pool}`,
      audience: process.env.COGNITO_CLIENT_ID,
      algorithms: ['RS256'], // Cognito id tokens are always RS256; pin to block alg-confusion
    });
    if (payload.token_use !== 'id' || !payload.sub) return null;
    const sub = String(payload.sub);
    if (await isRevoked(sub, payload.iat)) return null;
    const rawGroups = (payload as Record<string, unknown>)['cognito:groups'];
    const groups = Array.isArray(rawGroups) ? rawGroups.map(String) : [];
    return {
      sub,
      email: payload.email ? String(payload.email) : undefined,
      groups,
    };
  } catch {
    return null;
  }
}

// pentest-remediation P1-review (MAJOR-1): the original `clockTolerance: '3650 days'` accepted
// ANY expired token, no matter how old — a token expired for weeks (e.g. an old leaked cookie)
// could still hit this public, unauthenticated route and revoke the victim's *current* sessions,
// repeatedly. There's no legitimate reason for that: an id_token already expired by more than
// ordinary clock/network skew can't be used for anything else, so accepting it here bought zero
// benefit while opening a logout-DoS. 5 minutes covers real skew/latency, not a replayed-forever
// stale token.
const SIGNOUT_CLOCK_TOLERANCE = '5 minutes';

/** Like verifyUser, but tolerates a token expired within `SIGNOUT_CLOCK_TOLERANCE` — signature/
 * issuer/audience/token_use are still fully checked, so this cannot be forged. Used only by
 * signout: a user must be able to log out (and revoke) with a token that just expired (clock
 * skew / request latency), and the whole point of revocation-on-logout is to cut off a token
 * that may be stolen but is still (nearly) live. Never use this for granting access — only for
 * extracting a trusted `sub` to revoke. */
export async function verifyUserForSignout(cookieHeader: string | null): Promise<User | null> {
  const token = parseCookie(cookieHeader, 'awsops_token');
  if (!token) return null;
  const region = process.env.AWS_REGION || 'ap-northeast-2';
  const pool = process.env.COGNITO_USER_POOL_ID;
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: `https://cognito-idp.${region}.amazonaws.com/${pool}`,
      audience: process.env.COGNITO_CLIENT_ID,
      algorithms: ['RS256'],
      clockTolerance: SIGNOUT_CLOCK_TOLERANCE,
    });
    if (payload.token_use !== 'id' || !payload.sub || !payload.iat) return null;
    // `iat` is returned so the caller (signout route) can bound revokeSessionsFor's cutoff to
    // this specific token's issue time — see MAJOR-1 comment on revokeSessionsFor.
    return { sub: String(payload.sub), iat: payload.iat };
  } catch {
    return null;
  }
}
