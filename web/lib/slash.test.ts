import { describe, it, expect } from 'vitest';
import { parseSlash, matchCommands } from './slash';

const CUSTOM = [{ key: 'sre-2', label: 'sre-2', icon: '', active: true }];
it('recognizes only registered custom commands, including digits', () => {
  expect(parseSlash('/sre-2 inspect errors', CUSTOM)).toEqual({ section: 'sre-2', prompt: 'inspect errors' });
  expect(parseSlash('/sre-2 inspect errors')).toEqual({ section: null, prompt: '/sre-2 inspect errors' });
  expect(matchCommands('sr', CUSTOM)).toEqual(CUSTOM);
});
it('custom entries cannot replace built-ins or introduce invalid or disabled commands', () => {
  const extra = [...CUSTOM, { key: 'cost', label: 'override', icon: '', active: true },
    { key: 'disabled', label: 'disabled', icon: '', active: false }];
  expect(matchCommands('cost', extra)[0].label).not.toBe('override');
  expect(parseSlash('/disabled hi', extra).section).toBeNull();
});

describe('parseSlash', () => {
  it('routes a leading /section command, body verbatim', () => {
    expect(parseSlash('/cost foo')).toEqual({ section: 'cost', prompt: 'foo' });
  });
  it('consumes exactly one separator and keeps the rest verbatim', () => {
    expect(parseSlash('/cost   foo')).toEqual({ section: 'cost', prompt: '  foo' });
    expect(parseSlash('/cost\nfoo')).toEqual({ section: 'cost', prompt: 'foo' });
  });
  it('command with no body → empty prompt (chip-then-wait)', () => {
    expect(parseSlash('/network')).toEqual({ section: 'network', prompt: '' });
  });
  it('/auto maps to null section (explicit auto)', () => {
    expect(parseSlash('/auto x')).toEqual({ section: null, prompt: 'x' });
  });
  it('unknown command → literal passthrough', () => {
    expect(parseSlash('/bogus x')).toEqual({ section: null, prompt: '/bogus x' });
  });
  it('no separator (/costfoo) → literal', () => {
    expect(parseSlash('/costfoo')).toEqual({ section: null, prompt: '/costfoo' });
  });
  it('leading whitespace before slash → literal (not a command)', () => {
    expect(parseSlash('  /cost x')).toEqual({ section: null, prompt: '  /cost x' });
  });
  it('mid-text slash → literal', () => {
    expect(parseSlash('a /cost')).toEqual({ section: null, prompt: 'a /cost' });
  });
  it('plain text → auto', () => {
    expect(parseSlash('hello')).toEqual({ section: null, prompt: 'hello' });
  });
});

describe('matchCommands', () => {
  it('prefix-filters by key', () => {
    const keys = matchCommands('co').map((c) => c.key);
    expect(keys).toContain('container');
    expect(keys).toContain('cost');
  });
  it('empty fragment returns all incl. auto', () => {
    const keys = matchCommands('').map((c) => c.key);
    expect(keys).toContain('auto');
    expect(keys).toContain('network');
  });
  it('commands carry label/icon/active', () => {
    const cost = matchCommands('cost')[0];
    expect(cost).toMatchObject({ key: 'cost', active: true });
    expect(typeof cost.label).toBe('string');
    expect(typeof cost.icon).toBe('string');
  });
});
