// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { s3AccessRoles } from './S3IamAccessSection';

describe('s3AccessRoles (gap L242 — managed-policy matching)', () => {
  it('matches AmazonS3* and AdministratorAccess policies; others do not count', () => {
    const { hits, anySynced } = s3AccessRoles([
      { resource_id: 'r1', attached_policy_arns: ['arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess'] },
      { resource_id: 'r2', attached_policy_arns: ['arn:aws:iam::aws:policy/AdministratorAccess'] },
      { resource_id: 'r3', attached_policy_arns: ['arn:aws:iam::aws:policy/AmazonEC2FullAccess'] },
    ]);
    expect(anySynced).toBe(true);
    expect(hits.map((h) => h.name)).toEqual(['r1', 'r2']);
    expect(hits[0].policies).toEqual(['AmazonS3ReadOnlyAccess']);
  });
  it('rows without the synced column set anySynced=false (pre-apply state ≠ genuinely empty)', () => {
    const { hits, anySynced } = s3AccessRoles([{ resource_id: 'r1' }, { resource_id: 'r2' }]);
    expect(anySynced).toBe(false);
    expect(hits).toEqual([]);
  });
  it('caps at 30 roles (the v1 cap)', () => {
    const rows = Array.from({ length: 35 }, (_, i) => ({
      resource_id: `r${i}`, attached_policy_arns: ['arn:aws:iam::aws:policy/AmazonS3FullAccess'],
    }));
    expect(s3AccessRoles(rows).hits).toHaveLength(30);
  });
});
