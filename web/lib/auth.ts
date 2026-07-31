import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getPool } from './db';

export interface User {
  sub: string;
  email?: string;
  groups?: string[];
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

async function isRevoked(sub: string, iat: number | undefined): Promise<boolean> {
  if (!iat) return true; // malformed token (no iat) — fail closed, this one input we don't trust
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('revocation check timed out')), REVOCATION_CHECK_TIMEOUT_MS),
    );
    const { rows } = await Promise.race([
      getPool().query<{ revoked_at: string }>(
        'SELECT revoked_at FROM session_revocations WHERE user_sub = $1',
        [sub],
      ),
      timeout,
    ]);
    if (rows.length === 0) return false;
    const revokedAtSec = new Date(rows[0].revoked_at).getTime() / 1000;
    return iat <= revokedAtSec;
  } catch (e) {
    // fail open — see comment above the timeout constant / module comment
    console.warn(JSON.stringify({ evt: 'revocation_check_failed', sub, err: e instanceof Error ? e.message : String(e) }));
    return false;
  }
}

/** Record that `sub`'s sessions issued up to now are no longer valid. Called by POST
 * /api/auth/signout. Idempotent (upsert) — repeated logout just advances the cutoff. */
export async function revokeSessionsFor(sub: string): Promise<void> {
  await getPool().query(
    `INSERT INTO session_revocations (user_sub, revoked_at) VALUES ($1, now())
     ON CONFLICT (user_sub) DO UPDATE SET revoked_at = now()`,
    [sub],
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
    if (payload.token_use !== 'id' || !payload.sub) return null;
    return { sub: String(payload.sub) };
  } catch {
    return null;
  }
}
