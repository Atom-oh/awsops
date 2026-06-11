import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isClusterOnboarded } from './opencost-allowlist';

const orig = process.env.ONBOARDED_EKS_CLUSTERS;
afterEach(() => { process.env.ONBOARDED_EKS_CLUSTERS = orig; });

describe('isClusterOnboarded', () => {
  beforeEach(() => { process.env.ONBOARDED_EKS_CLUSTERS = 'fsi-demo-cluster, mall-apne2-az-a ,'; });
  it('matches a member (trimming + dropping empties)', () => {
    expect(isClusterOnboarded('fsi-demo-cluster')).toBe(true);
    expect(isClusterOnboarded('mall-apne2-az-a')).toBe(true);
  });
  it('rejects a non-member', () => {
    expect(isClusterOnboarded('nope')).toBe(false);
    expect(isClusterOnboarded('')).toBe(false);
  });
  it('is false when the env is unset/empty', () => {
    delete process.env.ONBOARDED_EKS_CLUSTERS;
    expect(isClusterOnboarded('fsi-demo-cluster')).toBe(false);
    process.env.ONBOARDED_EKS_CLUSTERS = '   ';
    expect(isClusterOnboarded('fsi-demo-cluster')).toBe(false);
  });
});
