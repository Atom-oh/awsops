// Default-off regression: remediation is FROZEN by ADR-005; governed external writes
// are GATED by ADR-007. Both defaults remain false, but their approval paths differ.
// A default-value assertion fails CI if someone flips either default to true.
//
// Reads terraform/v2/foundation/variables.tf (committed, always present in CI) — NOT
// terraform.tfvars (gitignored, per-environment, never present on a CI runner; the original
// version of this test read tfvars directly and had never actually run in CI before the
// merge-verify gate existed, silently checking flag names — remediation_execute_enabled,
// autonomous_enabled, autonomous_mitigation_enabled, mutating_tools_enabled, byo_mcp_enabled —
// that were renamed away and no longer exist, so 5 of 7 assertions were vacuously true).
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { variableDefault } from '../tf-frozen-flags';

const VARIABLES_TF = new URL('../../../terraform/v2/foundation/variables.tf', import.meta.url);

describe('FROZEN remediation and GATED external-write defaults (ADR-005/007)', () => {
  const tf = readFileSync(VARIABLES_TF, 'utf8');

  it('external integration WRITE stays disabled by default (propose-only / flag-OFF)', () => {
    expect(variableDefault(tf, 'integrations_write_enabled')).toBe('false');
  });

  it('the remediation/autonomous mutating substrate stays disabled by default', () => {
    expect(variableDefault(tf, 'remediation_enabled')).toBe('false');
  });
});
