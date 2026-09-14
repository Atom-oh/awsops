import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const RDS_CA_BUNDLE = fileURLToPath(new URL('./eks/rds-ca-bundle.pem', import.meta.url));

/** Verify the database chain and hostname using the already committed RDS roots. */
export function migrationTls(host, caPath = RDS_CA_BUNDLE) {
  if (typeof host !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(host)) {
    throw new Error('Invalid database hostname for TLS verification');
  }
  const ca = readFileSync(caPath, 'utf8');
  const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (!certificates.length || certificates.some((pem) => !new X509Certificate(pem).ca)) {
    throw new Error('Invalid RDS CA bundle');
  }
  return { ca, rejectUnauthorized: true, servername: host };
}
