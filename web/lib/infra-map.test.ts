import { describe, it, expect } from 'vitest';
import { buildInfraMap, highlightClosure, searchMatches, type InfraMapInput, type InvRow } from './infra-map';

const row = (resource_id: string, data: Record<string, unknown> = {}): InvRow =>
  ({ resource_id, region: 'ap-northeast-2', data });

const empty = (): InfraMapInput =>
  ({ igw: [], tgw: [], vpc: [], subnet: [], ec2: [], alb: [], nlb: [], rds: [], nat: [] });

const fixture = (): InfraMapInput => ({
  ...empty(),
  igw: [row('igw-1', { attachments: [{ VpcId: 'vpc-a', State: 'available' }] })],
  tgw: [row('tgw-1', { state: 'available', description: 'core' })],
  vpc: [
    row('vpc-a', { name: 'prod', cidr_block: '10.0.0.0/16' }),
    row('vpc-b', { name: 'dev', cidr_block: '10.1.0.0/16' }),
  ],
  subnet: [
    row('subnet-a1', { vpc_id: 'vpc-a', availability_zone: 'apne2-a', cidr_block: '10.0.1.0/24', map_public_ip_on_launch: true, name: 'pub-a' }),
    row('subnet-a2', { vpc_id: 'vpc-a', availability_zone: 'apne2-c', cidr_block: '10.0.2.0/24', map_public_ip_on_launch: false }),
  ],
  ec2: [row('i-1', { name: 'web', subnet_id: 'subnet-a2', vpc_id: 'vpc-a', instance_state: 'running', instance_type: 't4g.large', private_ip_address: '10.0.2.10' })],
  alb: [row('alb-x', { name: 'edge', vpc_id: 'vpc-a', state_code: 'active', scheme: 'internal', availability_zones: [{ SubnetId: 'subnet-a1' }, { SubnetId: 'subnet-a2' }] })],
  rds: [row('db-1', { engine: 'aurora-postgresql', status: 'available', class: 'db.serverless', vpc_id: 'vpc-a' })],
  nat: [row('nat-1', { vpc_id: 'vpc-a', subnet_id: 'subnet-a1', state: 'available' })],
  tgwAttachments: [{ tgwId: 'tgw-1', resourceType: 'vpc', resourceId: 'vpc-b' }],
});

describe('buildInfraMap', () => {
  it('assigns kinds to their columns', () => {
    const g = buildInfraMap(fixture());
    const col = (id: string) => g.nodes.find((n) => n.id === id)?.column;
    expect(col('igw:igw-1')).toBe(0);
    expect(col('tgw:tgw-1')).toBe(0);
    expect(col('vpc:vpc-a')).toBe(1);
    expect(col('subnet:subnet-a1')).toBe(2);
    expect(col('ec2:i-1')).toBe(3);
    expect(col('alb:alb-x')).toBe(3);
    expect(col('rds:db-1')).toBe(3);
    expect(col('nat:nat-1')).toBe(4);
  });

  it('draws containment/attachment edges', () => {
    const g = buildInfraMap(fixture());
    const has = (s: string, t: string) => g.edges.some((e) => e.source === s && e.target === t);
    expect(has('igw:igw-1', 'vpc:vpc-a')).toBe(true);
    expect(has('tgw:tgw-1', 'vpc:vpc-b')).toBe(true);
    expect(has('vpc:vpc-a', 'subnet:subnet-a1')).toBe(true);
    expect(has('subnet:subnet-a2', 'ec2:i-1')).toBe(true);
    expect(has('vpc:vpc-a', 'rds:db-1')).toBe(true); // RDS attaches at VPC (no subnet id synced)
    expect(has('subnet:subnet-a1', 'nat:nat-1')).toBe(true);
  });

  it('fans a multi-subnet ALB out to one edge per subnet', () => {
    const g = buildInfraMap(fixture());
    const albEdges = g.edges.filter((e) => e.target === 'alb:alb-x');
    expect(albEdges.map((e) => e.source).sort()).toEqual(['subnet:subnet-a1', 'subnet:subnet-a2']);
  });

  it('drops edges to unknown ids but keeps the node', () => {
    const input = { ...empty(), ec2: [row('i-orphan', { subnet_id: 'subnet-missing', instance_state: 'stopped' })] };
    const g = buildInfraMap(input);
    expect(g.nodes.some((n) => n.id === 'ec2:i-orphan')).toBe(true);
    expect(g.edges).toEqual([]);
  });

  it('marks status and public-subnet badge', () => {
    const g = buildInfraMap(fixture());
    const node = (id: string) => g.nodes.find((n) => n.id === id)!;
    expect(node('ec2:i-1').status).toBe('ok'); // running
    expect(node('nat:nat-1').status).toBe('ok'); // available
    expect(node('subnet:subnet-a1').badge).toContain('public');
    expect(node('subnet:subnet-a2').badge ?? '').not.toContain('public');
  });

  it('sorts subnets by (vpc, az, name) and stacks deterministically', () => {
    const g = buildInfraMap(fixture());
    const subnets = g.nodes.filter((n) => n.kind === 'subnet').map((n) => n.id);
    expect(subnets).toEqual(['subnet:subnet-a1', 'subnet:subnet-a2']);
  });

  it('uses name as label with id fallback', () => {
    const g = buildInfraMap(fixture());
    expect(g.nodes.find((n) => n.id === 'vpc:vpc-a')?.label).toBe('prod');
    expect(g.nodes.find((n) => n.id === 'subnet:subnet-a2')?.label).toBe('subnet-a2');
  });
});

describe('highlightClosure', () => {
  it('EC2 selection lights ancestors up to VPC (and its IGW) but not sibling subnets', () => {
    const g = buildInfraMap(fixture());
    const hl = highlightClosure(g, 'ec2:i-1');
    expect(hl.has('ec2:i-1')).toBe(true);
    expect(hl.has('subnet:subnet-a2')).toBe(true);
    expect(hl.has('vpc:vpc-a')).toBe(true);
    expect(hl.has('igw:igw-1')).toBe(true); // ancestor of vpc-a
    expect(hl.has('subnet:subnet-a1')).toBe(false); // sibling — must stay dim
    expect(hl.has('rds:db-1')).toBe(false); // sibling
  });

  it('VPC selection lights all descendants and its external ancestors', () => {
    const g = buildInfraMap(fixture());
    const hl = highlightClosure(g, 'vpc:vpc-a');
    for (const id of ['subnet:subnet-a1', 'subnet:subnet-a2', 'ec2:i-1', 'alb:alb-x', 'rds:db-1', 'nat:nat-1', 'igw:igw-1']) {
      expect(hl.has(id)).toBe(true);
    }
    expect(hl.has('vpc:vpc-b')).toBe(false);
    expect(hl.has('tgw:tgw-1')).toBe(false); // attached to vpc-b only
  });
});

describe('searchMatches', () => {
  it('matches instance type and private IP through meta', () => {
    const g = buildInfraMap(fixture());
    expect(searchMatches(g, 't4g.large').has('ec2:i-1')).toBe(true);
    expect(searchMatches(g, '10.0.2.10').has('ec2:i-1')).toBe(true);
  });
  it('matches CIDR and is case-insensitive on labels', () => {
    const g = buildInfraMap(fixture());
    expect(searchMatches(g, '10.0.1.0/24').has('subnet:subnet-a1')).toBe(true);
    expect(searchMatches(g, 'PROD').has('vpc:vpc-a')).toBe(true);
  });
  it('returns empty set for blank query', () => {
    const g = buildInfraMap(fixture());
    expect(searchMatches(g, '   ').size).toBe(0);
  });
});
