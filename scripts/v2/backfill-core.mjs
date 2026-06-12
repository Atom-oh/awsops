// scripts/v2/backfill-core.mjs
// Pure helpers for the v1 → v2 Aurora backfill (driven by scripts/v2/backfill-v1.mjs).
// No fs, no DB, no side effects — unit-tested in backfill-core.test.mjs (`node --test`).
//
// Spec:    docs/superpowers/specs/2026-06-12-v1-to-v2-aurora-backfill-design.md
// Mapping: derived verbatim from src/lib/db/*-writer.ts (zero parity drift with the
//          v1 runtime dual-write layer) and the DDL in
//          terraform/v2/foundation/data/schema.sql.

const DATE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/;
const MONTH_DIR_RE = /^\d{4}-\d{2}$/;
const SUMMARY_TOP_RE = /^summary-\d{4}-\d{2}\.json$/;

// ---------------------------------------------------------------------------
// Directory / file classification
// ---------------------------------------------------------------------------

/** A per-(account,day) snapshot file: exactly `YYYY-MM-DD.json`. */
export function isDateFile(name) {
  return DATE_FILE_RE.test(name);
}

/** An alert-diagnosis month directory: exactly `YYYY-MM`. */
export function isMonthDir(name) {
  return MONTH_DIR_RE.test(name);
}

/** A per-incident alert record file: a `.json` that is not a monthly summary. */
export function isAlertRecordFile(name) {
  return name.endsWith('.json') && name !== 'summary.json' && !SUMMARY_TOP_RE.test(name);
}

/** The Steampipe aggregator key `aws` is stored as `aggregate` (mirrors the writers). */
export function normalizeAccount(id) {
  return id === 'aws' ? 'aggregate' : id;
}

/**
 * Partition an `inventory/` or `cost/` directory listing into per-account
 * subdirectories (multi-account layout) and root-level single-account date
 * files. Skips `.prev_*`, the root aggregate, and any non-date file at the root.
 *
 * @param {Array<{name: string, isDirectory: boolean}>} entries
 * @returns {{accountDirs: string[], rootDateFiles: string[]}}
 */
export function partitionAccountDir(entries) {
  const accountDirs = [];
  const rootDateFiles = [];
  for (const e of entries) {
    if (e.isDirectory) accountDirs.push(e.name);
    else if (isDateFile(e.name)) rootDateFiles.push(e.name);
  }
  return { accountDirs, rootDateFiles };
}
