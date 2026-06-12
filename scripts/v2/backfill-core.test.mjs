// scripts/v2/backfill-core.test.mjs — unit tests for the pure backfill core.
// Run: node --test scripts/v2/backfill-core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDateFile, isMonthDir, isAlertRecordFile, normalizeAccount, partitionAccountDir,
} from './backfill-core.mjs';

// --- classification --------------------------------------------------------

test('isDateFile accepts YYYY-MM-DD.json, rejects everything else', () => {
  assert.ok(isDateFile('2026-06-01.json'));
  assert.ok(!isDateFile('.prev_180294183052.json'));
  assert.ok(!isDateFile('latest.json'));
  assert.ok(!isDateFile('2026-06-01.txt'));
  assert.ok(!isDateFile('2026-6-1.json')); // not zero-padded
  assert.ok(!isDateFile('2026-06-01'));
});

test('isMonthDir matches YYYY-MM only', () => {
  assert.ok(isMonthDir('2026-06'));
  assert.ok(!isMonthDir('2026-06-01'));
  assert.ok(!isMonthDir('summary-2026-06'));
});

test('isAlertRecordFile skips summaries', () => {
  assert.ok(isAlertRecordFile('inc-abc123.json'));
  assert.ok(!isAlertRecordFile('summary.json'));
  assert.ok(!isAlertRecordFile('summary-2026-06.json'));
  assert.ok(!isAlertRecordFile('inc-abc123.txt'));
});

test('normalizeAccount maps aws→aggregate, leaves others', () => {
  assert.equal(normalizeAccount('aws'), 'aggregate');
  assert.equal(normalizeAccount('180294183052'), '180294183052');
  assert.equal(normalizeAccount('self'), 'self');
});

test('partitionAccountDir splits account dirs vs root date files, skips junk', () => {
  const entries = [
    { name: '180294183052', isDirectory: true },
    { name: 'aws', isDirectory: true },
    { name: '2026-06-01.json', isDirectory: false },
    { name: '.prev_180294183052.json', isDirectory: false },
    { name: 'latest.json', isDirectory: false },
  ];
  const { accountDirs, rootDateFiles } = partitionAccountDir(entries);
  assert.deepEqual(accountDirs, ['180294183052', 'aws']);
  assert.deepEqual(rootDateFiles, ['2026-06-01.json']);
});

test('partitionAccountDir on a pure single-account dir', () => {
  const { accountDirs, rootDateFiles } = partitionAccountDir([
    { name: '2026-06-01.json', isDirectory: false },
    { name: '2026-06-02.json', isDirectory: false },
  ]);
  assert.deepEqual(accountDirs, []);
  assert.deepEqual(rootDateFiles, ['2026-06-01.json', '2026-06-02.json']);
});
