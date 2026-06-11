// Pure core for the `make migrate` runner — no pg, no fs side effects (callers pass content in).
// Collision-free DB migrations: sortable ULID ids, pending-only diff, LF-normalized checksums,
// duplicate-id precheck, no-transaction flag. Unit-tested by web/lib/migrate-core.test.ts.
import { createHash } from 'node:crypto';

// Crockford base32 ULID, 26 chars (case-insensitive). Excludes I L O U.
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** True iff `id` is a well-formed ULID. Rejects short/manual ids (P2: no hand-numbered ids). */
export function validateId(id) {
  return typeof id === 'string' && ULID_RE.test(id);
}

/** Parse `<ULID>_<snake_name>.sql` → { id, name }. Returns null if malformed / non-ULID id. */
export function parseMigrationFile(filename) {
  const m = /^([^_]+)_(.+)\.sql$/.exec(filename);
  if (!m) return null;
  const [, id, name] = m;
  if (!validateId(id)) return null;
  return { id, name };
}

/** Lexical sort (ULIDs are lexicographically time-ordered). Legacy integer ledger rows are
 *  applied-only (never appear as migration files), so they never enter this ordering. */
export function sortIds(ids) {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Pending = file ids not yet recorded, sorted. Finds ALL gaps (not just > max). */
export function computePending(fileIds, appliedIds) {
  const applied = new Set(appliedIds);
  return sortIds(fileIds.filter((id) => !applied.has(id)));
}

/** sha256 of LF-normalized text (P2: avoid git CRLF/LF drift producing spurious checksum errors). */
export function sha256(text) {
  return createHash('sha256').update(String(text).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Duplicate ids across migration filenames → fail-loud precheck (before connecting). */
export function findDuplicateIds(filenames) {
  const seen = new Set(), dup = new Set();
  for (const f of filenames) {
    const p = parseMigrationFile(f);
    if (!p) continue;
    if (seen.has(p.id)) dup.add(p.id);
    else seen.add(p.id);
  }
  return [...dup];
}

/** True iff the migration opts out of the wrapping transaction (e.g. CREATE INDEX CONCURRENTLY). */
export function hasNoTxnFlag(sqlText) {
  return /^\s*--\s*migrate:no-transaction\b/m.test(String(sqlText));
}
