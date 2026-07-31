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

async function runInTimeoutScopedTransaction<T>(runQuery: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
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
    client.release();
  }
}

/** Race any pooled query against a client-side timer AND a server-side `SET LOCAL
 * statement_timeout` (see comment above) — the client-side race alone doesn't free a connection
 * still stuck server-side; the timeout alone doesn't help if the connection can't even be
 * acquired from the pool. Both isRevoked (read) and revokeSessionsFor (write) go through this. */
async function withStatementTimeout<T>(runQuery: (client: PoolClient) => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('statement timed out')), REVOCATION_CHECK_TIMEOUT_MS);
    });
    return await Promise.race([runInTimeoutScopedTransaction(runQuery), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function isRevoked(sub: string, iat: number | undefined): Promise<boolean> {
  if (!iat) return true; // malformed token (no iat) — fail closed, this one input we don't trust
  try {
    const { rows } = await withStatementTimeout<{ revoked_at: string }>((client) =>
      client.query('SELECT revoked_at FROM session_revocations WHERE user_sub = $1', [sub]),
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
export async function revokeSessionsFor(sub: string, iat: number): Promise<void> {
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
