import { describe, it, expect } from 'vitest';
import { deriveRow } from './inventory-derived';

// ecr deriver (gap-audit L107): scan_on_push Yes/No from the JSONB scanning config.
describe('deriveRow ecr scan_on_push', () => {
  it('Yes when scan_on_push is true (object form)', () => {
    expect(deriveRow('ecr', { image_scanning_configuration: { scan_on_push: true } }).scan_on_push).toBe('Yes');
  });
  it('Yes when the config arrives as a JSON string with PascalCase key', () => {
    expect(deriveRow('ecr', { image_scanning_configuration: '{"ScanOnPush": "true"}' }).scan_on_push).toBe('Yes');
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
