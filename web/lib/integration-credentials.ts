// web/lib/integration-credentials.ts
// DevOps-agent-style credential-write UX. ONE Secrets Manager secret
// (ops/${project}/integrations/credentials) holds a JSON map keyed by integration KIND (slug):
//   { "notion": {"token": "..."}, "datadog": {...} }
// The connector Lambda reads the same secret and extracts map[INTEGRATION_SLUG].
//
// SECURITY: the BFF writes (PutSecretValue) but NEVER returns/logs credential values.
// Secrets Manager PutSecretValue has no conditional-put, so concurrent admin writes to different
// slugs would clobber the shared map — we serialize the read-modify-write under a pg advisory lock.
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { getPool } from '@/lib/db';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const SECRET_NAME =
  process.env.INTEGRATIONS_SECRET_NAME || 'ops/awsops-v2/integrations/credentials';

// Kinds that have a connector Lambda reading this secret (INTEGRATION_SLUG = kind). Extend as
// connectors are added. An arbitrary key is rejected (no arbitrary secret-key injection).
export const KNOWN_CONNECTOR_SLUGS = ['notion', 'clickhouse', 'prometheus', 'loki'] as const;

const MAX_SECRET_PAYLOAD_BYTES = 65000; // Secrets Manager limit is 64 KB/version
const LOCK_KEY = 729153866; // fixed advisory-lock key for the single credentials secret

let smc: SecretsManagerClient | null = null;
function client(): SecretsManagerClient {
  if (!smc) smc = new SecretsManagerClient({ region: REGION });
  return smc;
}

function assertKnownSlug(slug: string): void {
  if (!(KNOWN_CONNECTOR_SLUGS as readonly string[]).includes(slug)) {
    throw new Error(`unknown integration slug: ${slug}`);
  }
}

async function readMap(): Promise<Record<string, unknown>> {
  try {
    const r = await client().send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    if (!r.SecretString) return {};
    const m = JSON.parse(r.SecretString);
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
  } catch (e: unknown) {
    if ((e as { name?: string })?.name === 'ResourceNotFoundException') return {};
    throw e;
  }
}

/** Store one integration's credential under its slug. Serialized via a pg advisory lock so
 *  concurrent admin writes to the shared single secret cannot clobber each other. */
export async function setIntegrationCredential(
  slug: string,
  secretObj: Record<string, unknown>,
): Promise<void> {
  assertKnownSlug(slug); // before any I/O — unknown slug ⇒ no SM/DB call
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const map = await readMap();
    map[slug] = secretObj;
    const payload = JSON.stringify(map);
    if (Buffer.byteLength(payload, 'utf8') > MAX_SECRET_PAYLOAD_BYTES) {
      throw new Error('integration credentials payload exceeds size limit');
    }
    await client().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: payload }));
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Slugs that currently have a stored credential — KEYS ONLY (never values). */
export async function getConfiguredSlugs(): Promise<string[]> {
  return Object.keys(await readMap());
}
