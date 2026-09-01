import { describe, it, expect } from 'vitest';
import { deriveRow } from './inventory-derived';

// lambda deriver (gap-audit L137, v1 parity): null runtime → 'custom'; last_modified formatted.
describe('deriveRow lambda formatting', () => {
  it('null/absent runtime becomes custom (container-image functions)', () => {
    expect(deriveRow('lambda', { runtime: null }).runtime).toBe('custom');
    expect(deriveRow('lambda', {}).runtime).toBe('custom');
    expect(deriveRow('lambda', { runtime: 'python3.12' }).runtime).toBe('python3.12');
  });
  it('last_modified formats to YYYY-MM-DD HH:mm; unparseable values pass through', () => {
    expect(deriveRow('lambda', { last_modified: '2026-08-31T10:00:00.000Z' }).last_modified).toBe('2026-08-31 10:00');
    expect(deriveRow('lambda', { last_modified: 'not-a-date' }).last_modified).toBe('not-a-date');
  });
});

// ecr deriver (gap-audit L107): scan_on_push Yes/No from the JSONB scanning config.
describe('deriveRow ecr scan_on_push', () => {
  it('Yes when scan_on_push is true (object form)', () => {
    expect(deriveRow('ecr', { image_scanning_configuration: { scan_on_push: true } }).scan_on_push).toBe('Yes');
  });
  it('Yes when the config arrives as a JSON string with PascalCase key', () => {
    expect(deriveRow('ecr', { image_scanning_configuration: '{"ScanOnPush": "true"}' }).scan_on_push).toBe('Yes');
  });
  // Truthiness mirrors countTruthy's FALSY set — 1 / "True" must not read KPI-enabled but column-'No'.
  it('Yes for a numeric 1 and a capitalized "True" (countTruthy parity)', () => {
    expect(deriveRow('ecr', { image_scanning_configuration: { scan_on_push: 1 } }).scan_on_push).toBe('Yes');
    expect(deriveRow('ecr', { image_scanning_configuration: '{"ScanOnPush": "True"}' }).scan_on_push).toBe('Yes');
  });
  it('No when scan_on_push is false', () => {
    expect(deriveRow('ecr', { image_scanning_configuration: { scan_on_push: false } }).scan_on_push).toBe('No');
  });
  it('No when the config is missing or malformed (API default is off)', () => {
    expect(deriveRow('ecr', {}).scan_on_push).toBe('No');
    expect(deriveRow('ecr', { image_scanning_configuration: 'not json {' }).scan_on_push).toBe('No');
  });
  it('preserves the original row fields', () => {
    const out = deriveRow('ecr', { repository_uri: 'x', image_scanning_configuration: { scan_on_push: true } });
    expect(out.repository_uri).toBe('x');
  });
});
