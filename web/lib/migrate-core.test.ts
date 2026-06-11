import { describe, it, expect } from 'vitest';
// scripts/ is a sibling of web/ — from web/lib/, `../..` is the worktree root.
import {
  validateId, parseMigrationFile, sortIds, computePending, sha256, findDuplicateIds, hasNoTxnFlag,
} from '../../scripts/v2/migrate-core.mjs';

const ULID = '01J9Z8XK3P7QF2VN6T0BC4D5EH';
const ULID2 = '01J9Z8XK3P7QF2VN6T0BC4D5FK';

describe('validateId', () => {
  it('accepts a 26-char ULID, rejects short/garbage', () => {
    expect(validateId(ULID)).toBe(true);
    expect(validateId('01J0')).toBe(false);
    expect(validateId('not-a-ulid')).toBe(false);
    expect(validateId('')).toBe(false);
  });
});

describe('parseMigrationFile', () => {
  it('parses <ULID>_<name>.sql', () => {
    expect(parseMigrationFile(`${ULID}_opencost_config.sql`)).toEqual({ id: ULID, name: 'opencost_config' });
  });
  it('rejects malformed / non-ULID id', () => {
    expect(parseMigrationFile('01J0_x.sql')).toBeNull(); // short id
    expect(parseMigrationFile('noiddotsql.sql')).toBeNull();
    expect(parseMigrationFile(`${ULID}.sql`)).toBeNull(); // no name
  });
});

describe('computePending', () => {
  it('returns file ids not yet applied, ULID-sorted', () => {
    expect(computePending([ULID2, ULID], [ULID])).toEqual([ULID2]);
    expect(computePending([ULID2, ULID], [])).toEqual([ULID, ULID2]); // sorted
  });
  it('finds ALL gaps, not just > max (out-of-order merges)', () => {
    // applied has the LATER id; an earlier un-applied id must still surface
    expect(computePending([ULID, ULID2], [ULID2])).toEqual([ULID]);
  });
  it('legacy integer applied rows never appear as pending', () => {
    expect(computePending([ULID], ['1', '2', '11'])).toEqual([ULID]);
  });
});

describe('sha256 (LF-normalized)', () => {
  it('is stable and CRLF-insensitive', () => {
    expect(sha256('a\nb')).toBe(sha256('a\r\nb')); // git autocrlf safe
    expect(sha256('x')).toBe(sha256('x'));
    expect(sha256('x')).not.toBe(sha256('y'));
  });
});

describe('findDuplicateIds', () => {
  it('flags a duplicated id across files', () => {
    expect(findDuplicateIds([`${ULID}_a.sql`, `${ULID}_b.sql`, `${ULID2}_c.sql`])).toEqual([ULID]);
    expect(findDuplicateIds([`${ULID}_a.sql`, `${ULID2}_b.sql`])).toEqual([]);
  });
});

describe('hasNoTxnFlag', () => {
  it('detects the no-transaction header', () => {
    expect(hasNoTxnFlag('-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY ...')).toBe(true);
    expect(hasNoTxnFlag('CREATE TABLE x ();')).toBe(false);
  });
});

describe('sortIds', () => {
  it('lexical order', () => {
    expect(sortIds([ULID2, ULID])).toEqual([ULID, ULID2]);
  });
});
