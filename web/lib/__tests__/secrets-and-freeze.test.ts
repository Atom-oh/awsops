// Task 22 — AWS-freeze regression: the datasource/connector work must NOT enable any mutating /
// autonomous / external-write capability. These flags are permanently frozen (2026-06-11 reversal).
// A grep-style assertion fails CI if someone flips them on while touching this feature.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const TFVARS = new URL('../../../terraform/v2/foundation/terraform.tfvars', import.meta.url);

describe('AWS-resource-mutation / external-write freeze', () => {
  const tfvars = readFileSync(TFVARS, 'utf8');

  function flag(name: string): string | null {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(\\S+)`, 'm').exec(tfvars);
    return m ? m[1] : null; // null = not set → defaults to false in variables.tf
  }

  it('external integration WRITE stays disabled (propose-only / flag-OFF)', () => {
    expect(flag('integrations_write_enabled')).not.toBe('true');
  });

  it('no remediation / autonomous / mutating substrate flag is enabled', () => {
    for (const name of [
      'remediation_enabled',
      'remediation_execute_enabled',
      'autonomous_enabled',
      'autonomous_mitigation_enabled',
      'mutating_tools_enabled',
      'byo_mcp_enabled',
    ]) {
      expect(flag(name)).not.toBe('true');
    }
  });
});
