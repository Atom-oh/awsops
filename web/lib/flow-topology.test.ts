import { describe, it, expect } from 'vitest';
import { buildFlowGraph, filterFromEntry, TARGET_CAP } from './flow-topology';

// Fixtures in REAL Steampipe shape: flattened { resource_id, region, ...data } where nested
// jsonb columns keep AWS SDK PascalCase keys. alb/nlb resource_id = name; tg resource_id = arn.
const ALB_ARN = 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/web/abc';
const TG_ARN = 'arn:aws:elasticloadbalancing:ap-northeast-2:1:targetgroup/web-tg/def';
const WAF_ARN = 'arn:aws:wafv2:us-east-1:1:global/webacl/prod/xyz';
const ALB_ID = `alb:${ALB_ARN}`;

const alb = { resource_id: 'web', region: 'ap-northeast-2', arn: ALB_ARN, dns_name: 'internal-web-123.ap-northeast-2.elb.amazonaws.com', vpc_id: 'vpc-1' };
const waf = { resource_id: 'prod', region: 'us-east-1', arn: WAF_ARN };
const tg = {
  resource_id: TG_ARN, region: 'ap-northeast-2', target_group_name: 'web-tg', target_type: 'ip',
  load_balancer_arns: [ALB_ARN],
  target_health_descriptions: [
    { Target: { Id: '10.0.1.5', Port: 3000 }, TargetHealth: { State: 'healthy' } },
    { Target: { Id: '10.0.1.6', Port: 3000 }, TargetHealth: { State: 'unhealthy' } },
  ],
};

describe('buildFlowGraph — CF→LB/WAF edges', () => {
  it('links CF→ALB when an origin DomainName matches alb.dns_name (case-insensitive)', () => {
    const cf = { resource_id: 'D1', region: 'us-east-1', origins: [{ Id: 'o1', DomainName: 'INTERNAL-WEB-123.AP-NORTHEAST-2.ELB.AMAZONAWS.COM' }] };
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb] });
    expect(g.nodes.find((n) => n.id === 'cf:D1')).toBeTruthy();
    expect(g.nodes.find((n) => n.id === ALB_ID)).toBeTruthy();
    const e = g.edges.find((x) => x.source === 'cf:D1' && x.target === ALB_ID);
    expect(e).toBeTruthy();
    expect(e!.confidence).toBe('observed');
  });

  it('links CF→WAF by web_acl_id matched against waf.arn', () => {
    const cf = { resource_id: 'D1', region: 'us-east-1', web_acl_id: WAF_ARN, origins: [] };
    const g = buildFlowGraph({ cloudfront: [cf], waf: [waf] });
    expect(g.edges.find((x) => x.source === 'cf:D1' && x.target === 'waf:prod')).toBeTruthy();
  });

  it('labels the CF node with its custom domain (aliases) when present', () => {
    const cf = { resource_id: 'D1', region: 'us-east-1', domain_name: 'd1.cloudfront.net', aliases: { Items: ['app.example.com'] }, origins: [] };
    const g = buildFlowGraph({ cloudfront: [cf] });
    expect(g.nodes.find((n) => n.id === 'cf:D1')?.label).toBe('app.example.com');
  });
});

describe('buildFlowGraph — Route53 entry', () => {
  const cf = { resource_id: 'D1', region: 'us-east-1', domain_name: 'd111.cloudfront.net', aliases: { Items: ['app.example.com'] }, origins: [] };

  it('links Route53 ALIAS record → CloudFront when alias_target matches the CF domain', () => {
    const rec = { resource_id: 'app.example.com A', name: 'app.example.com.', type: 'A', alias_target: { DNSName: 'd111.cloudfront.net.' } };
    const g = buildFlowGraph({ route53: [rec], cloudfront: [cf] });
    const r53 = g.nodes.find((n) => n.kind === 'route53');
    expect(r53).toBeTruthy();
    expect(g.edges.find((x) => x.source === r53!.id && x.target === 'cf:D1')).toBeTruthy();
  });

  it('links Route53 → ALB when alias_target matches the LB dns_name', () => {
    const rec = { resource_id: 'direct.example.com A', name: 'direct.example.com.', type: 'A', alias_target: { DNSName: `${alb.dns_name}.` } };
    const g = buildFlowGraph({ route53: [rec], alb: [alb] });
    expect(g.edges.find((x) => x.source.startsWith('r53:') && x.target === ALB_ID)).toBeTruthy();
  });

  it('skips Route53 records that resolve to nothing tracked (no orphan DNS clutter)', () => {
    const rec = { resource_id: 'ext.example.com CNAME', name: 'ext.example.com.', type: 'CNAME', alias_target: { DNSName: 'somewhere-external.example.org.' } };
    const g = buildFlowGraph({ route53: [rec], cloudfront: [cf] });
    expect(g.nodes.find((n) => n.kind === 'route53')).toBeFalsy();
  });

  it('VPC-origin distribution (public FQDN + VpcOriginConfig) → unresolved origin node, no false LB edge', () => {
    const cf = { resource_id: 'D1', region: 'us-east-1', origins: [{ Id: 'o1', DomainName: 'awsops-v2.atomai.click', VpcOriginConfig: { VpcOriginId: 'vo_abc' } }] };
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb] });
    // no false CF→ALB edge (DomainName is the public FQDN, not the ALB dns_name)
    expect(g.edges.find((x) => x.target === ALB_ID)).toBeFalsy();
    // an explicit unresolved-origin node exists, linked from CF
    const origin = g.nodes.find((n) => n.kind === 'origin');
    expect(origin).toBeTruthy();
    expect(g.edges.find((x) => x.source === 'cf:D1' && x.target === origin!.id)).toBeTruthy();
  });

  it('plain origin matching nothing → unresolved origin node (no throw, no false edge)', () => {
    const cf = { resource_id: 'D1', region: 'us-east-1', origins: [{ Id: 'o1', DomainName: 'some-bucket.s3.amazonaws.com' }] };
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb] });
    expect(g.nodes.find((n) => n.kind === 'origin')).toBeTruthy();
    expect(g.edges.find((x) => x.target === ALB_ID)).toBeFalsy();
  });
});

describe('buildFlowGraph — ALB→TG→target', () => {
  it('links ALB→TG via load_balancer_arns (matched by arn, not node name)', () => {
    const g = buildFlowGraph({ alb: [alb], tg: [tg] });
    expect(g.edges.find((x) => x.source === ALB_ID && x.target === `tg:${TG_ARN}`)).toBeTruthy();
  });

  it('fans TG→target out of target_health_descriptions with health in meta (PascalCase)', () => {
    const g = buildFlowGraph({ tg: [tg] });
    const targets = g.nodes.filter((n) => n.kind === 'target');
    expect(targets.length).toBe(2);
    const healthy = targets.find((n) => n.label.includes('10.0.1.5'));
    expect(healthy?.meta?.health).toBe('healthy');
    expect(g.edges.filter((x) => x.source === `tg:${TG_ARN}` && x.target.startsWith('target:')).length).toBe(2);
  });

  it('TG with empty/garbage targets still yields a node and never throws', () => {
    const empty = { resource_id: 'arn:tg:empty', target_group_name: 'empty', load_balancer_arns: [], target_health_descriptions: [] };
    const garbage = { resource_id: 'arn:tg:bad', target_group_name: 'bad', target_health_descriptions: 'not-an-array' };
    const g = buildFlowGraph({ tg: [empty, garbage] });
    expect(g.nodes.find((n) => n.id === 'tg:arn:tg:empty')).toBeTruthy();
    expect(g.nodes.find((n) => n.id === 'tg:arn:tg:bad')).toBeTruthy();
  });

  it('caps targets per TG with a "+N more" node (never silent truncation)', () => {
    const many = {
      resource_id: 'arn:tg:big', target_group_name: 'big',
      target_health_descriptions: Array.from({ length: TARGET_CAP + 5 }, (_, i) => ({ Target: { Id: `10.0.0.${i}` }, TargetHealth: { State: 'healthy' } })),
    };
    const g = buildFlowGraph({ tg: [many] });
    const targets = g.nodes.filter((n) => n.kind === 'target' && n.id.startsWith('target:arn:tg:big'));
    expect(targets.length).toBe(TARGET_CAP);
    expect(g.nodes.find((n) => n.kind === 'more' && n.label.includes('5'))).toBeTruthy();
  });
});

describe('buildFlowGraph — backend resolution (instance/lambda)', () => {
  it('resolves an instance target to its EC2 Name', () => {
    const tgInst = { resource_id: 'arn:tg:inst', target_group_name: 'inst', target_type: 'instance',
      target_health_descriptions: [{ Target: { Id: 'i-0abc' }, TargetHealth: { State: 'healthy' } }] };
    const ec2 = { resource_id: 'i-0abc', name: 'web-server-1' };
    const g = buildFlowGraph({ tg: [tgInst], ec2: [ec2] });
    expect(g.nodes.find((n) => n.kind === 'target')?.label).toBe('web-server-1');
    expect(g.nodes.find((n) => n.kind === 'target')?.meta?.resolved).toBe('ec2');
  });

  it('resolves a lambda target to its function name', () => {
    const FN_ARN = 'arn:aws:lambda:ap-northeast-2:1:function:my-fn';
    const tgFn = { resource_id: 'arn:tg:fn', target_group_name: 'fn', target_type: 'lambda',
      target_health_descriptions: [{ Target: { Id: FN_ARN }, TargetHealth: { State: 'healthy' } }] };
    const lam = { resource_id: 'my-fn', arn: FN_ARN };
    const g = buildFlowGraph({ tg: [tgFn], lambda: [lam] });
    expect(g.nodes.find((n) => n.kind === 'target')?.label).toBe('my-fn');
  });

  it('leaves an ip target raw (Spec 2 resolves ECS/EKS)', () => {
    const tgIp = { resource_id: 'arn:tg:ip', target_group_name: 'ip', target_type: 'ip',
      target_health_descriptions: [{ Target: { Id: '10.0.1.9' }, TargetHealth: { State: 'healthy' } }] };
    const g = buildFlowGraph({ tg: [tgIp] });
    expect(g.nodes.find((n) => n.kind === 'target')?.label).toBe('10.0.1.9');
  });
});

describe('buildFlowGraph — invariants', () => {
  it('same-named LBs in different regions stay distinct (ARN-keyed node id)', () => {
    const albA = { resource_id: 'web', region: 'ap-northeast-2', arn: ALB_ARN, dns_name: 'a.elb.amazonaws.com' };
    const albB = { resource_id: 'web', region: 'us-east-1', arn: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/web/zzz', dns_name: 'b.elb.amazonaws.com' };
    const g = buildFlowGraph({ alb: [albA, albB] });
    expect(g.nodes.filter((n) => n.kind === 'alb').length).toBe(2);
  });

  it('no dangling edges; node dedup', () => {
    const g = buildFlowGraph({ alb: [alb, alb], tg: [tg] });
    expect(g.nodes.filter((n) => n.id === ALB_ID).length).toBe(1);
    for (const e of g.edges) {
      expect(g.nodes.find((n) => n.id === e.source), e.source).toBeTruthy();
      expect(g.nodes.find((n) => n.id === e.target), e.target).toBeTruthy();
    }
  });
});

describe('filterFromEntry', () => {
  const cf = { resource_id: 'D1', region: 'us-east-1', origins: [{ Id: 'o1', DomainName: alb.dns_name }] };
  const full = buildFlowGraph({ cloudfront: [cf], alb: [alb], tg: [tg] });

  it('returns the reachable subtree from an entry node', () => {
    const sub = filterFromEntry(full, 'cf:D1');
    expect(sub.nodes.find((n) => n.id === 'cf:D1')).toBeTruthy();
    expect(sub.nodes.find((n) => n.id === ALB_ID)).toBeTruthy();
    expect(sub.nodes.find((n) => n.id === `tg:${TG_ARN}`)).toBeTruthy();
    expect(sub.nodes.filter((n) => n.kind === 'target').length).toBe(2);
  });

  it('an LB entry yields only its downstream (ALB→TG→targets), not the CF above it', () => {
    const sub = filterFromEntry(full, ALB_ID);
    expect(sub.nodes.find((n) => n.id === 'cf:D1')).toBeFalsy();
    expect(sub.nodes.find((n) => n.id === `tg:${TG_ARN}`)).toBeTruthy();
  });

  it('null/absent entry returns the full graph', () => {
    expect(filterFromEntry(full, null).nodes.length).toBe(full.nodes.length);
    expect(filterFromEntry(full, 'nope:x').nodes.length).toBe(full.nodes.length);
  });
});
