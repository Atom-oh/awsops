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

describe('deriveRow opensearch structured detail (gap L150)', () => {
  const full = {
    cluster_config: {
      InstanceType: 'r6g.large.search', InstanceCount: 3,
      DedicatedMasterEnabled: true, DedicatedMasterType: 'm6g.large.search', DedicatedMasterCount: 3,
      ZoneAwarenessEnabled: true, ZoneAwarenessConfig: { AvailabilityZoneCount: 3 },
      WarmEnabled: false, ColdStorageOptions: { Enabled: false }, MultiAZWithStandbyEnabled: true,
    },
    ebs_options: { EBSEnabled: true, VolumeType: 'gp3', VolumeSize: 100, Iops: 3000, Throughput: 125 },
    vpc_options: { VPCId: 'vpc-1', SubnetIds: ['subnet-a', 'subnet-b'], SecurityGroupIds: ['sg-1'], AvailabilityZones: ['apne2-az1'] },
    encryption_at_rest_options: { Enabled: true, KmsKeyId: 'key-1' },
    advanced_security_options: { Enabled: true, InternalUserDatabaseEnabled: false, AnonymousAuthEnabled: false },
    cognito_options: { Enabled: false },
    node_to_node_encryption_options_enabled: true,
  };

  it('flattens cluster_config into readable fields', () => {
    const d = deriveRow('opensearch', { ...full });
    expect(d.dedicated_master_h).toBe('m6g.large.search × 3');
    expect(d.zone_awareness_h).toBe('enabled (3 AZ)');
    expect(d.warm_storage_h).toBe('disabled');
    expect(d.cold_storage_h).toBe('disabled');
    expect(d.multi_az_standby_h).toBe('enabled');
  });

  it('EBS one-liner carries type/size/IOPS/throughput; VPC arrays pass through raw (idlist rows)', () => {
    const d = deriveRow('opensearch', { ...full });
    expect(d.ebs_volume_h).toBe('gp3 · 100 GB · 3000 IOPS · 125 MB/s');
    expect(d.vpc_id_h).toBe('vpc-1');
    expect(d.subnets_h).toEqual(['subnet-a', 'subnet-b']); // arrays stay arrays → one-per-row rendering
    expect(d.security_groups_h).toEqual(['sg-1']);
  });

  it('security fields: KMS key surfaced, advanced-security as real booleans (Badge rendering)', () => {
    const d = deriveRow('opensearch', { ...full });
    expect(d.kms_key_h).toBe('key-1');
    expect(d.adv_security_h).toBe(true);
    expect(d.internal_user_db_h).toBe(false);
    expect(d.cognito_h).toBe(false);
  });

  it('missing JSONB blobs → undefined fields (absent from the panel), never fabricated values', () => {
    const d = deriveRow('opensearch', { resource_id: 'dom-2' });
    expect(d.dedicated_master_h).toBeUndefined();
    expect(d.ebs_volume_h).toBeUndefined();
    expect(d.adv_security_h).toBeUndefined();
    expect(d.cognito_h).toBeUndefined();
  });

  it('EBS disabled renders disabled (blob present, feature off)', () => {
    const d = deriveRow('opensearch', { ebs_options: { EBSEnabled: false } });
    expect(d.ebs_volume_h).toBe('disabled');
  });

  it('an EMPTY {} blob never fabricates disabled — absent keys stay undefined', () => {
    const d = deriveRow('opensearch', { cluster_config: {}, ebs_options: {}, advanced_security_options: {} });
    expect(d.dedicated_master_h).toBeUndefined();
    expect(d.cold_storage_h).toBeUndefined();
    expect(d.ebs_volume_h).toBeUndefined();
    expect(d.adv_security_h).toBeUndefined();
  });

  it("string-typed booleans ('true'/'false') are tolerated like boolH", () => {
    const d = deriveRow('opensearch', {
      cluster_config: { DedicatedMasterEnabled: 'false', ColdStorageOptions: { Enabled: 'true' } },
      advanced_security_options: { Enabled: 'true' },
    });
    expect(d.dedicated_master_h).toBe('disabled');
    expect(d.cold_storage_h).toBe('enabled');
    expect(d.adv_security_h).toBe(true);
  });
});
