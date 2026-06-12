#!/usr/bin/env node
// scripts/v2/backfill-v1.mjs
// One-time, idempotent backfill of v1 high-value history (data/*.json) into the
// v2 Aurora ADR-030 app-state tables. Tool only — reads a *copy* of v1's data/.
//
//   node scripts/v2/backfill-v1.mjs --data-dir <path> [--only a,b] [--account-id <id>]
//                                   [--alert-source <s>] [--dry-run]
//
// Sources → tables:
//   inventory  data/inventory/[<acct>/]<YYYY-MM-DD>.json   → inventory_snapshots
//   cost       data/cost/[<acct>/]<YYYY-MM-DD>.json         → cost_snapshots
//   alert      data/alert-diagnosis/<YYYY-MM>/<id>.json     → alert_diagnosis
//   scaling    data/event-scaling/<id>.json                 → event_scaling_plans
//
// Credentials (live runs): --dsn / BACKFILL_DSN → AURORA_SECRET_ARN+AURORA_ENDPOINT
//   → `terraform -chdir=terraform/v2/foundation output -raw …` (mirrors migrate.mjs).
// The DSN/credentials are NEVER printed. --dry-run parses + counts with NO DB connection.
//
// Spec:  docs/superpowers/specs/2026-06-12-v1-to-v2-aurora-backfill-design.md
// Mapping is in backfill-core.mjs (derived from src/lib/db/*-writer.ts).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as core from './backfill-core.mjs';

export const SOURCES = ['inventory', 'cost', 'alert', 'scaling'];

const die = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };

function printHelp() {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n')
    .filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
}

/** Hide the password in any DSN before it can reach a log line. */
export function redactDsn(dsn) {
  if (!dsn) return dsn;
  return dsn.replace(/(\/\/[^:/@]+:)[^@]*(@)/, '$1***$2');
}

export function parseArgs(argv) {
  const a = {
    dataDir: null, only: [...SOURCES], accountId: 'self', alertSource: 'unknown',
    dryRun: process.env.DRY_RUN === '1', dsn: process.env.BACKFILL_DSN || null,
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--help' || x === '-h') { printHelp(); process.exit(0); }
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--data-dir') a.dataDir = argv[++i];
    else if (x === '--only') a.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (x === '--account-id') a.accountId = argv[++i];
    else if (x === '--alert-source') a.alertSource = argv[++i];
    else if (x === '--dsn') a.dsn = argv[++i];
    else die(`unknown arg: ${x} (try --help)`);
  }
  if (!a.dataDir) die('--data-dir <path> is required');
  if (!existsSync(a.dataDir)) die(`--data-dir not found: ${a.dataDir}`);
  const bad = a.only.filter((s) => !SOURCES.includes(s));
  if (bad.length) die(`--only: unknown source(s): ${bad.join(',')} (valid: ${SOURCES.join(',')})`);
  return a;
}

// --- filesystem helpers ----------------------------------------------------

const listEntries = (dir) => readdirSync(dir, { withFileTypes: true })
  .map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Wrap a mapper call so a parse/map throw becomes an {error} work item. */
function tryMap(file, fn) {
  try { return { file, result: fn() }; }
  catch (e) { return { file, result: { error: e instanceof Error ? e.message : String(e) } }; }
}

// --- per-source gatherers (parse → core mapper) ----------------------------

export function gatherInventory(dataDir, defaultAccount) {
  const dir = join(dataDir, 'inventory');
  if (!existsSync(dir)) return [];
  const { accountDirs, rootDateFiles } = core.partitionAccountDir(listEntries(dir));
  const jobs = [];
  for (const acct of accountDirs) {
    const adir = join(dir, acct);
    for (const e of listEntries(adir)) if (!e.isDirectory && core.isDateFile(e.name)) jobs.push({ file: join(adir, e.name), account: acct });
  }
  for (const f of rootDateFiles) jobs.push({ file: join(dir, f), account: defaultAccount });
  return jobs.map((j) => tryMap(j.file, () => core.mapInventory(readJson(j.file), j.account)));
}

export function gatherCost(dataDir, defaultAccount) {
  const dir = join(dataDir, 'cost');
  if (!existsSync(dir)) return [];
  const { accountDirs, rootDateFiles } = core.partitionAccountDir(listEntries(dir));
  const jobs = [];
  for (const acct of accountDirs) {
    const adir = join(dir, acct);
    for (const e of listEntries(adir)) if (!e.isDirectory && core.isDateFile(e.name)) jobs.push({ file: join(adir, e.name), account: acct });
  }
  for (const f of rootDateFiles) jobs.push({ file: join(dir, f), account: defaultAccount });
  return jobs.map((j) => tryMap(j.file, () => core.mapCost(readJson(j.file), j.account)));
}

export function gatherAlert(dataDir, source) {
  const dir = join(dataDir, 'alert-diagnosis');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of listEntries(dir)) {
    if (!e.isDirectory || !core.isMonthDir(e.name)) continue;
    const mdir = join(dir, e.name);
    for (const f of listEntries(mdir)) {
      if (f.isDirectory || !core.isAlertRecordFile(f.name)) continue;
      const file = join(mdir, f.name);
      out.push(tryMap(file, () => core.mapAlert(readJson(file), { source })));
    }
  }
  return out;
}

export function gatherScaling(dataDir) {
  const dir = join(dataDir, 'event-scaling');
  if (!existsSync(dir)) return [];
  return listEntries(dir)
    .filter((e) => !e.isDirectory && e.name.endsWith('.json'))
    .map((e) => { const file = join(dir, e.name); return tryMap(file, () => core.mapScaling(readJson(file))); });
}

export function gatherAll(args) {
  const g = {};
  if (args.only.includes('inventory')) g.inventory = gatherInventory(args.dataDir, args.accountId);
  if (args.only.includes('cost')) g.cost = gatherCost(args.dataDir, args.accountId);
  if (args.only.includes('alert')) g.alert = gatherAlert(args.dataDir, args.alertSource);
  if (args.only.includes('scaling')) g.scaling = gatherScaling(args.dataDir);
  return g;
}

/** Count what a source would write/skip/error (no DB). */
export function summarizeDryRun(source, items) {
  let wouldWrite = 0, skipped = 0, errored = 0;
  for (const { result } of items) {
    if (result.error) errored++;
    else if (result.skip) skipped++;
    else if (source === 'inventory') wouldWrite += result.rows.length;
    else wouldWrite += 1;
  }
  return { files: items.length, wouldWrite, skipped, errored };
}

function sampleLine(source, r) {
  if (source === 'inventory') return `${r.account} ${r.capturedAt} (${r.rows.length} rows)`;
  if (source === 'cost') return `${r.account} ${r.periodStart} ${r.granularity}`;
  if (source === 'alert') return `${r.incidentId} ${r.severity} ${r.occurredAt}`;
  return `${r.planId} ${r.status} ${r.eventStartAt}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gathered = gatherAll(args);

  if (args.dryRun) {
    console.log(`DRY-RUN (no DB) — data-dir=${args.dataDir} account=${args.accountId} alert-source=${args.alertSource}`);
    let totalErr = 0;
    for (const s of args.only) {
      const sum = summarizeDryRun(s, gathered[s]);
      totalErr += sum.errored;
      console.log(`  ${s}: scanned=${sum.files} would-write=${sum.wouldWrite} skipped=${sum.skipped} errored=${sum.errored}`);
      const sample = gathered[s].find((i) => !i.result.error && !i.result.skip);
      if (sample) console.log(`    sample: ${sampleLine(s, sample.result)}`);
    }
    process.exit(totalErr > 0 ? 1 : 0);
  }

  // Live write path is wired in Task 4.
  die('live write path not yet implemented — re-run with --dry-run (Task 4 adds DB writes)');
}

// Only run when executed directly (not when imported by tests/itest).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => die(e instanceof Error ? e.message : String(e)));
}
