// scripts/v2/backfill-owner-sub.mjs
// Step 2 of the ownership-key termination procedure (ADR-009 Amendment).
//
// Rows written before the sub cut-over hold `requested_by = <email>`. Because email is MUTABLE and
// can be REASSIGNED, matching ownership on it means a new holder of a departed user's address can
// read that user's legacy rows. `matchesIdentity()` therefore still accepts the email form, gated on
// LEGACY_EMAIL_OWNER_MATCH — and that flag cannot be turned off until these rows carry the
// immutable Cognito sub instead. This script drives that rewrite in TWO explicit steps.
//
//   node scripts/v2/backfill-owner-sub.mjs                       # PLAN only: writes the plan, changes nothing
//   node scripts/v2/backfill-owner-sub.mjs --apply <plan.json>    # APPLY exactly the entries in that plan
//
// WHY TWO STEPS, AND WHY NOTHING IS INFERRED
//
// The mapping this needs is "which sub owned this address WHEN THE ROW WAS WRITTEN". Cognito cannot
// answer that. An earlier revision of this script tried to approximate it by comparing each row
// group's oldest created_at against the mapped user's `UserCreateDate` — but UserCreateDate is when
// the ACCOUNT was created, not when it acquired the address. The most common reassignment is an
// existing, long-lived account taking over a departed colleague's address, and that sails straight
// through such a check: the account predates the rows, so the guard approves moving the victim's
// worker_jobs / diagnosis_reports / compliance_runs onto the new holder's sub, and then prints
// "Safe to deploy" (PR #195 review CRITICAL). A reversible READ exposure would have become an
// IRREVERSIBLE ownership transfer, which is the opposite of this script's stated contract.
//
// So it does not guess. It emits a plan with the evidence it has, and an operator decides. Deleting
// an entry from the plan is how you refuse it. Only entries present in the approved plan are applied,
// and each is re-verified at apply time against BOTH the database (the rows still hold the planned
// old value) and Cognito (the address still resolves to the planned sub, with a verified email).
// Verifying only the database was the earlier gap: the plan records an operator's approval of
// specific ROWS, not a standing guarantee about the IDENTITY behind an address.
//
// A second refusal, added after review (codex stop-gate): only users whose Cognito `email_verified`
// is "true" are eligible at all. verifyUser() already refuses to honour an unverified email claim on
// READ; trusting one here would undo that in the irreversible direction, since the rewrite moves the
// rows onto that sub permanently and sub-keyed rows are fully trusted afterwards. Guarding only the
// reversible path is not a guard.
//
// After a clean apply (every legacy row rewritten, nothing left pending), deploy with
// LEGACY_EMAIL_OWNER_MATCH=false — step 3.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import pg from 'pg';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const ROOT = new URL('../..', import.meta.url).pathname;
// Both artifacts carry the FULL email -> Cognito sub mapping plus the affected row ids, so they are
// gitignored AND written 0600 (PR #203 review, 3 models). The .gitignore patterns key off this
// prefix, so an operator-supplied PLAN_PATH must keep it — otherwise a differently-named plan is
// committable, which is exactly what the gitignore was for.
const ARTIFACT_PREFIX = 'backfill-owner-sub';
const PLAN_PATH = process.env.PLAN_PATH || `${ARTIFACT_PREFIX}-plan.json`;
if (!basename(PLAN_PATH).startsWith(ARTIFACT_PREFIX)) {
  die(`PLAN_PATH basename must start with "${ARTIFACT_PREFIX}" (it carries every user's email->sub `
    + `mapping and the .gitignore patterns key off that prefix); got: ${PLAN_PATH}`);
}

const applyIdx = process.argv.indexOf('--apply');
const APPLY_FROM = applyIdx >= 0 ? process.argv[applyIdx + 1] : null;
if (applyIdx >= 0 && !APPLY_FROM) die('--apply needs a plan file path');

// Every column that carries an ownership key. Keep in sync with matchesIdentity()'s callers.
const TARGETS = [
  { table: 'worker_jobs', column: 'requested_by', pk: 'job_id' },
  { table: 'diagnosis_reports', column: 'requested_by', pk: 'id' },
  { table: 'compliance_runs', column: 'requested_by', pk: 'id' },
];

function die(m) { console.error(`backfill-owner-sub: ${m}`); process.exit(1); }
const tf = (out) => execSync(`terraform -chdir=terraform/v2/foundation output -raw ${out}`,
  { cwd: ROOT, encoding: 'utf8' }).trim();

function loadCreds() {
  const cfg = JSON.parse(execSync(
    `aws secretsmanager get-secret-value --region ${REGION} --secret-id ${tf('aurora_secret_arn')}` +
    ' --query SecretString --output text', { cwd: ROOT, encoding: 'utf8' }));
  return {
    host: tf('aurora_endpoint'), user: cfg.username, password: cfg.password,
    database: 'awsops', port: 5432, ssl: { rejectUnauthorized: false },
  };
}

/** email (lowercased) -> { sub, accountCreated } for every user whose email is VERIFIED.
 *
 * Unverified addresses are deliberately excluded, which makes them show up as unmapped rather than
 * as a rewrite target (codex stop-gate). This is the same rule verifyUser() applies to the token
 * claim, and skipping it here would have undone that fix in the worst possible direction: the read
 * gate refuses to honour an unverified email, but a rewrite keyed off one moves the victim's rows
 * onto that sub PERMANENTLY — and rows owned by sub are fully trusted afterwards. A control that
 * only guards the reversible path while the irreversible path stays open is not a control.
 */
function cognitoUsersByEmail() {
  const poolId = tf('cognito_user_pool_id');
  const map = new Map();
  // Paginate. A truncated map would report real users as "no such address" — fail-safe but
  // misleading, since the operator would read it as "this person is gone".
  let token = null;
  do {
    const out = execSync(
      `aws cognito-idp list-users --region ${REGION} --user-pool-id ${poolId} --max-items 60` +
      (token ? ` --starting-token ${token}` : '') +
      " --query '{u: Users[].{a: Attributes, c: UserCreateDate}, t: NextToken}' --output json",
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 32e6 });
    const page = JSON.parse(out);
    for (const u of page.u || []) {
      const byName = Object.fromEntries((u.a || []).map((a) => [a.Name, a.Value]));
      // `email_verified` arrives as the STRING "true" from Cognito's attribute list, not a boolean.
      if (byName.email && byName.sub && byName.email_verified === 'true') {
        map.set(byName.email.toLowerCase(), { sub: byName.sub, accountCreated: u.c || null });
      }
    }
    token = page.t || null;
  } while (token);
  return map;
}

/** Every legacy email-keyed row group, with the row ids so a plan entry is exact. */
async function scan(client) {
  const groups = [];
  for (const { table, column, pk } of TARGETS) {
    const { rows } = await client.query(
      `SELECT ${column} AS owner, count(*)::int AS n, min(created_at) AS oldest,
              max(created_at) AS newest, array_agg(${pk}::text ORDER BY ${pk}) AS ids
         FROM ${table} WHERE ${column} LIKE '%@%' GROUP BY ${column}`);
    for (const r of rows) groups.push({ table, column, pk, ...r });
  }
  return groups;
}

async function plan(client) {
  const users = cognitoUsersByEmail();
  if (users.size === 0) die('Cognito returned no users — refusing to write a plan');
  console.log(`pool: ${users.size} users`);

  const groups = await scan(client);
  if (groups.length === 0) {
    console.log('No legacy email-keyed rows. Nothing to do — safe to deploy with LEGACY_EMAIL_OWNER_MATCH=false.');
    return;
  }

  const entries = [];
  const unmapped = [];
  for (const g of groups) {
    const hit = users.get(String(g.owner).toLowerCase());
    if (!hit) { unmapped.push(g); continue; }
    entries.push({
      table: g.table, column: g.column, pk: g.pk,
      from: g.owner, to: hit.sub, rows: g.n, ids: g.ids,
      evidence: {
        rowsWritten: `${g.oldest} .. ${g.newest}`,
        currentHolderAccountCreated: hit.accountCreated,
        // Stated for every entry, not just suspicious ones: the tool cannot tell these apart.
        note: 'Cognito does not record WHEN this address was acquired. Confirm this sub owned it for the whole window above, then keep this entry; delete it to refuse.',
      },
    });
  }

  writeFileSync(PLAN_PATH, JSON.stringify({ generated: 'plan', entries }, null, 2), { mode: 0o600 });
  console.log(`\nplan written: ${PLAN_PATH} (${entries.length} entries, ${entries.reduce((a, e) => a + e.rows, 0)} rows) — NOTHING CHANGED`);
  console.log('Review every entry. Delete the ones you cannot vouch for, then:');
  console.log(`  node scripts/v2/backfill-owner-sub.mjs --apply ${PLAN_PATH}`);
  if (unmapped.length > 0) {
    console.log(`\nNOT IN THE PLAN — no user holds these addresses with a VERIFIED email:`);
    for (const g of unmapped) console.log(`  ${g.owner}  (${g.table}, ${g.n} rows)`);
    console.log('Two different causes, and they need different handling:');
    console.log('  - the address exists in the pool but is UNVERIFIED -> do NOT rewrite. An');
    console.log('    unverified address proves nothing about who controls the mailbox, and a');
    console.log('    rewrite is irreversible. Verify it (or correct the holder) first.');
    console.log('  - the address is absent (deleted user) -> find the original sub, or retire the');
    console.log('    rows. Nothing here can recover the owner.');
    console.log('Either way keep LEGACY_EMAIL_OWNER_MATCH=true until these are resolved.');
  }
  process.exitCode = 2;   // a plan is not a completed migration
}

async function apply(client) {
  const parsed = JSON.parse(readFileSync(APPLY_FROM, 'utf8'));
  const entries = parsed.entries || [];
  if (entries.length === 0) die(`${APPLY_FROM} has no entries`);

  // RE-CHECK COGNITO HERE, not just in plan() (codex stop-gate). The verified-email gate lived only
  // in cognitoUsersByEmail(), which plan() calls — apply() trusted the plan file's from→to pairing
  // outright. A plan written before that gate existed, or one whose addresses changed or lost
  // verification in between, would have been applied anyway. The plan is an operator's *approval*
  // of specific rows; it is not evidence that the identity behind an address is still the same one,
  // and this is the step that cannot be undone.
  const users = cognitoUsersByEmail();
  if (users.size === 0) die('Cognito returned no users with a verified email — refusing to apply');
  const rejected = [];
  for (const e of entries) {
    const hit = users.get(String(e.from).toLowerCase());
    if (!hit) {
      rejected.push(`${e.from} -> ${e.to}: no user holds this address with a VERIFIED email now`);
    } else if (hit.sub !== e.to) {
      rejected.push(`${e.from} -> ${e.to}: address now belongs to ${hit.sub}, not the planned sub`);
    }
  }
  if (rejected.length > 0) {
    console.error('\nREFUSING TO APPLY — the plan no longer matches Cognito:');
    for (const r of rejected) console.error(`  ${r}`);
    die('re-run the plan step and review the new plan; an ownership rewrite is not reversible');
  }

  // Journal BEFORE writing, per row id — an UPDATE erases the old value, so a journal written
  // afterwards from in-memory counts cannot reverse a partial failure (PR #195 review MAJOR: the
  // previous journal was row-nonspecific and written after the fact).
  const journalPath = `${APPLY_FROM.replace(/\.json$/, '')}-applied.json`;
  writeFileSync(journalPath, JSON.stringify({ startedFrom: APPLY_FROM, entries }, null, 2), { mode: 0o600 });
  console.log(`journal (pre-write, row-specific): ${journalPath}`);

  let total = 0;
  for (const e of entries) {
    if (!TARGETS.some((t) => t.table === e.table && t.column === e.column && t.pk === e.pk)) {
      die(`plan entry targets an unknown table/column: ${e.table}.${e.column}`);
    }
    // Re-verify at apply time and update exactly the planned rows: scoped to the ids AND still
    // holding the planned old value, so rows that changed since the plan are left alone.
    const r = await client.query(
      `UPDATE ${e.table} SET ${e.column} = $1
        WHERE ${e.pk}::text = ANY($2::text[]) AND ${e.column} = $3`,
      [e.to, e.ids, e.from]);
    total += r.rowCount;
    const skipped = e.ids.length - r.rowCount;
    console.log(`${e.table}.${e.column}: ${e.from} -> ${e.to} (${r.rowCount}/${e.ids.length} rows` +
      `${skipped ? `, ${skipped} changed since the plan — left alone` : ''})`);
  }
  console.log(`\nrewrote ${total} rows.`);

  const left = await scan(client);
  if (left.length > 0) {
    console.log('\nLegacy email-keyed rows REMAIN:');
    for (const g of left) console.log(`  ${g.owner}  (${g.table}, ${g.n} rows)`);
    console.log('LEGACY_EMAIL_OWNER_MATCH must stay true.');
    process.exitCode = 2;
  } else {
    console.log('\nNo legacy email-keyed rows left. Safe to deploy with LEGACY_EMAIL_OWNER_MATCH=false (step 3).');
  }
}

async function main() {
  const client = new pg.Client({ ...loadCreds(), statement_timeout: 300_000 });
  await client.connect();
  try {
    if (APPLY_FROM) await apply(client);
    else await plan(client);
  } finally {
    await client.end();
  }
}

main().catch((e) => die(e?.message || String(e)));
