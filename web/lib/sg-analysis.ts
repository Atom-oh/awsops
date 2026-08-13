import {
  EC2Client,
  DescribeSecurityGroupsCommand,
  DescribeNetworkInterfacesCommand,
  DescribeFlowLogsCommand,
  DescribeManagedPrefixListsCommand,
} from '@aws-sdk/client-ec2';
import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand, StopQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { nfmStatus, nfmTopContributors, NFM_MAX_RANGE_SEC, NFM_CATEGORIES } from './nfm';
import { classifyEni } from './ip-inventory';
import { getPool } from './db';

// Security Group 분석 (owner 요청 3축):
// ① 사용 유무 — 모든 부착은 ENI를 경유하므로 ENI Groups로 SG별 부착 수·리소스 종류를 집계하고,
//    다른 SG 룰의 소스 참조(UserIdGroupPairs)까지 봐서 둘 다 0이면 미사용(정리 후보).
// ② 소스/목적지 식별 — 룰의 peer를 사람이 읽게 해석: sg-참조→SG 이름, CIDR→인벤토리 VPC
//    이름 매칭, 0.0.0.0/0·::/0→인터넷 전체, pl-→관리형 프리픽스 리스트 이름.
// ③ 히트 매칭 — VPC Flow Logs(CWL 대상)가 있으면 SG ENI들의 플로우를 Insights로 집계해
//    인바운드 룰별 매칭 카운트(기간 내 매칭 0 룰 = 정리 후보 신호)를 산출. Flow Logs가 없으면
//    NFM(top-contributors, 1h 상한)으로 SG 뒤 리소스의 실제 트래픽 상대를 폴백 표시 —
//    이 계정 실측: Flow Logs 0건이라 NFM 폴백이 기본 경로. 룰 매칭은 targetPort 있는 행만
//    근사(정직 고지). 소스 생성(Flow Logs enable)은 ADR-005 동결이라 하지 않는다.

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const ec2Clients = new Map<string, EC2Client>();
const ec2 = (r: string) => {
  let c = ec2Clients.get(r);
  if (!c) { c = new EC2Client({ region: r }); ec2Clients.set(r, c); }
  return c;
};
const logsClients = new Map<string, CloudWatchLogsClient>();
const logs = (r: string) => {
  let c = logsClients.get(r);
  if (!c) { c = new CloudWatchLogsClient({ region: r }); logsClients.set(r, c); }
  return c;
};

const TTL_MS = 4 * 60_000;
const cache = new Map<string, { at: number; v: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().then((v) => { cache.set(key, { at: Date.now(), v }); return v; }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
export function _resetSgCacheForTests() { cache.clear(); inflight.clear(); ec2Clients.clear(); logsClients.clear(); detailCache = new Map(); ipLabelCache = new Map(); }

export interface SgRule {
  direction: 'ingress' | 'egress';
  /** 표시용 프로토콜 ('all' | 'tcp' | 'udp' | 'icmp' | 숫자). */
  protocol: string;
  fromPort: number | null; toPort: number | null;
  /** 표시용 포트 ('all' | '443' | '1024-2048'). */
  portRange: string;
  /** 원형 peer (CIDR | sg-id | pl-id). */
  peer: string;
  peerKind: 'internet' | 'cidr' | 'sg' | 'pl';
  /** 식별 라벨 — sg 이름, VPC 이름, '인터넷 전체', 프리픽스 리스트 이름. */
  peerLabel: string;
  description: string | null;
  open: boolean;
}

export interface SgUsageRow {
  id: string; name: string; description: string;
  region: string; vpcId: string;
  /** VPC Name 태그 병기 (없으면 id 그대로). */
  vpcLabel: string;
  isDefault: boolean;
  eniCount: number;
  /** 부착 리소스 종류 분포 (EC2/ALB/Lambda/RDS ... — ENI 분류 재사용). */
  attachedKinds: { kind: string; count: number }[];
  /** 이 SG를 룰 소스로 참조하는 다른 SG 라벨 ("sg-xxx (name)"). */
  referencedBy: string[];
  ingressRules: number; egressRules: number;
  /** 인터넷 전체(0.0.0.0/0·::/0) 인바운드 룰 수. */
  openIngress: number;
  /** 부착 0 + 참조 0 — 정리 후보. */
  unused: boolean;
  rules: SgRule[];
}

export interface SgAnalysis {
  rows: SgUsageRow[];
  totals: {
    total: number; attached: number;
    /** 부착 0 + 참조 0 (default SG는 제외 — 삭제 불가라 정리 후보가 아님). */
    unused: number;
    /** 부착은 없지만 다른 SG가 참조 중 (삭제 불가). */
    referencedOnly: number;
    openIngress: number; enis: number;
  };
  /** CWL 대상 VPC Flow Logs 보유 VPC 수 — 0이면 히트 매칭은 NFM 폴백. */
  flowLogVpcs: number;
  /** List/Describe 실패 또는 ENI 5000건 캡 도달로 해당 리전의 SG 목록·부착 집계가
   *  실제보다 적을 수 있는 리전 — 0/빈 결과를 "리전에 리소스 없음"으로 신뢰하면 안 됨
   *  (anfw.ts의 degradedRegions와 동일 계약). */
  degradedRegions: string[];
}

// ── 내부 상세(히트 매칭용) — 직렬화하지 않음 ────────────────────────────────
interface SgDetail {
  region: string; vpcId: string;
  eniIds: string[]; ips: string[];
  rules: SgRule[];
  /** 이 SG의 VPC를 커버하는 CWL flow log 그룹 (없으면 null). */
  flowLogGroup: string | null;
}
// build-then-swap: sgAnalysis 재실행이 clear()로 빈 구간을 만들면 진행 중 sgHits의 지연
// peer 조회가 깨지므로, 새 Map을 지역에서 채운 뒤 완료 시점에 원자 교체한다 (let 바인딩).
let detailCache = new Map<string, SgDetail>();
/** IP → 리소스 식별 (flow/NFM 상대 식별용). */
let ipLabelCache = new Map<string, string>();

async function regionsFromInventory(): Promise<string[]> {
  try {
    const r = await getPool().query<{ region: string }>(
      `SELECT DISTINCT region FROM inventory_resources WHERE resource_type = 'vpc' AND region IS NOT NULL`);
    const set = new Set(r.rows.map((x) => x.region));
    set.add(REGION);
    return [...set];
  } catch { return [REGION]; }
}

/** 인벤토리 VPC 이름/CIDR (peer CIDR 식별용). */
async function vpcMeta(): Promise<{ byId: Map<string, string>; cidrs: { cidr: string; label: string }[] }> {
  const byId = new Map<string, string>();
  const cidrs: { cidr: string; label: string }[] = [];
  try {
    const r = await getPool().query<{ resource_id: string; row: { name?: string; cidr_block?: string } }>(
      `SELECT resource_id, row FROM inventory_resources WHERE resource_type = 'vpc'`);
    for (const v of r.rows) {
      const label = v.row?.name || v.resource_id;
      byId.set(v.resource_id, label);
      if (v.row?.cidr_block) cidrs.push({ cidr: v.row.cidr_block, label });
    }
  } catch { /* Aurora 미가용 시 라벨만 생략 */ }
  return { byId, cidrs };
}

// ── IPv4/CIDR 매칭 (v6 룰은 ::/0=인터넷만 해석, 그 외 원형 표시) ─────────────
const ip4 = (s: string): number | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
};
export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const ipN = ip4(ip); const baseN = ip4(base);
  if (ipN == null || baseN == null || !Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (ipN & mask) === (baseN & mask);
}

const PROTO_NAME: Record<string, string> = { '6': 'tcp', '17': 'udp', '1': 'icmp', '58': 'icmpv6' };

// ── raw shapes ──────────────────────────────────────────────────────────────
interface RawPerm {
  IpProtocol?: string; FromPort?: number; ToPort?: number;
  IpRanges?: { CidrIp?: string; Description?: string }[];
  Ipv6Ranges?: { CidrIpv6?: string; Description?: string }[];
  UserIdGroupPairs?: { GroupId?: string; Description?: string }[];
  PrefixListIds?: { PrefixListId?: string; Description?: string }[];
}
interface RawSg {
  GroupId?: string; GroupName?: string; Description?: string; VpcId?: string;
  IpPermissions?: RawPerm[]; IpPermissionsEgress?: RawPerm[];
}
interface RawEni {
  NetworkInterfaceId?: string; InterfaceType?: string; Description?: string;
  Groups?: { GroupId?: string }[]; VpcId?: string;
  Attachment?: { InstanceId?: string };
  PrivateIpAddresses?: { PrivateIpAddress?: string }[]; PrivateIpAddress?: string;
}

const portRange = (from?: number, to?: number): string =>
  from == null || from === -1 ? 'all' : from === to ? String(from) : `${from}-${to}`;

/** 전 리전 SG 사용 현황 + 룰 식별 분석 (4분 TTL). */
export async function sgAnalysis(): Promise<SgAnalysis> {
  return cached('a', async () => {
    // clear()가 아니라 지역 Map에 채운 뒤 반환 직전 원자 교체 (진행 중 sgHits 보호).
    const nextDetail = new Map<string, SgDetail>();
    const nextIpLabel = new Map<string, string>();
    const [regions, vpcs] = await Promise.all([regionsFromInventory(), vpcMeta()]);

    const perRegion = await Promise.all(regions.map(async (region) => {
      let eniTruncated = false;
      try {
        // SG + ENI + 관리형 프리픽스 리스트 + flow logs (병렬, 각자 페이지네이션)
        const [sgs, enis, plNames, flowByVpc] = await Promise.all([
          (async () => {
            const out: RawSg[] = [];
            let NextToken: string | undefined;
            do {
              const r: { SecurityGroups?: RawSg[]; NextToken?: string } =
                await ec2(region).send(new DescribeSecurityGroupsCommand({ NextToken, MaxResults: 250 }));
              out.push(...(r.SecurityGroups ?? []));
              NextToken = r.NextToken;
            } while (NextToken);
            return out;
          })(),
          (async () => {
            const out: RawEni[] = [];
            let NextToken: string | undefined;
            do {
              const r: { NetworkInterfaces?: RawEni[]; NextToken?: string } =
                await ec2(region).send(new DescribeNetworkInterfacesCommand({ NextToken, MaxResults: 1000 }));
              out.push(...(r.NetworkInterfaces ?? []));
              NextToken = r.NextToken;
            } while (NextToken && out.length < 5000);
            // 5000건 캡에 물리면(우리 상한, API 제약 아님) 잘린 ENI들의 부착 집계가
            // 조용히 과소산정된다 — 무신호 금지, 리전을 degraded로 표시(리뷰 MAJOR류).
            if (NextToken) eniTruncated = true;
            return out;
          })(),
          (async () => {
            try {
              const r = await ec2(region).send(new DescribeManagedPrefixListsCommand({ MaxResults: 100 }));
              return new Map((r.PrefixLists ?? []).map((p) => [p.PrefixListId ?? '', p.PrefixListName ?? '']));
            } catch { return new Map<string, string>(); }
          })(),
          (async () => {
            // VPC 단위 CWL flow log 발견 — SG 히트 매칭의 1차 소스.
            // 리뷰 MAJOR: TrafficType=REJECT 전용 flow log는 ACCEPT 레코드가 전혀 없어
            // sgHits()의 ACCEPT 필터가 항상 0건으로 남는다 — 모든 인바운드 룰이 거짓
            // idle(정리 후보)로 보인다. ACCEPT/ALL만 룰-히트 소스로 채택, REJECT 전용은
            // 제외해 NFM 폴백으로 넘긴다(NFM은 hits=null로 정직 표기).
            try {
              const r = await ec2(region).send(new DescribeFlowLogsCommand({}));
              const m = new Map<string, string>();
              for (const f of r.FlowLogs ?? []) {
                if (f.LogDestinationType === 'cloud-watch-logs' && f.ResourceId?.startsWith('vpc-') && f.LogGroupName
                  && f.TrafficType !== 'REJECT') {
                  m.set(f.ResourceId, f.LogGroupName);
                }
              }
              return m;
            } catch { return new Map<string, string>(); }
          })(),
        ]);

        const sgName = new Map(sgs.map((g) => [g.GroupId ?? '', g.GroupName ?? '']));
        const label = (id: string) => {
          const n = sgName.get(id);
          return n ? `${id} (${n})` : id;
        };

        // ENI → SG별 부착 집계 + IP 식별 맵
        const eniByGroup = new Map<string, { ids: string[]; ips: string[]; kinds: Map<string, number> }>();
        for (const e of enis) {
          const { kind, resource } = classifyEni(e.InterfaceType ?? 'interface', e.Description ?? '', e.Attachment?.InstanceId ?? null);
          const ips = (e.PrivateIpAddresses ?? []).map((p) => p.PrivateIpAddress).filter((x): x is string => !!x);
          if (ips.length === 0 && e.PrivateIpAddress) ips.push(e.PrivateIpAddress);
          for (const ip of ips) nextIpLabel.set(ip, resource ? `${kind}: ${resource}` : kind);
          for (const g of e.Groups ?? []) {
            if (!g.GroupId) continue;
            const cur = eniByGroup.get(g.GroupId) ?? { ids: [] as string[], ips: [] as string[], kinds: new Map<string, number>() };
            cur.ids.push(e.NetworkInterfaceId ?? '');
            cur.ips.push(...ips);
            cur.kinds.set(kind, (cur.kinds.get(kind) ?? 0) + 1);
            eniByGroup.set(g.GroupId, cur);
          }
        }

        // SG 상호참조 (이 SG를 소스로 쓰는 SG들)
        const referencedBy = new Map<string, Set<string>>();
        for (const g of sgs) {
          for (const perm of [...(g.IpPermissions ?? []), ...(g.IpPermissionsEgress ?? [])]) {
            for (const pair of perm.UserIdGroupPairs ?? []) {
              if (!pair.GroupId || pair.GroupId === g.GroupId) continue;
              const set = referencedBy.get(pair.GroupId) ?? new Set();
              set.add(g.GroupId ?? '');
              referencedBy.set(pair.GroupId, set);
            }
          }
        }

        const toRules = (perms: RawPerm[], direction: SgRule['direction']): SgRule[] => {
          const out: SgRule[] = [];
          for (const p of perms) {
            const protocol = p.IpProtocol === '-1' ? 'all' : (PROTO_NAME[p.IpProtocol ?? ''] ?? p.IpProtocol ?? '?');
            const base = {
              direction, protocol,
              fromPort: p.FromPort ?? null, toPort: p.ToPort ?? null,
              portRange: p.IpProtocol === '-1' ? 'all' : portRange(p.FromPort, p.ToPort),
            };
            for (const r of p.IpRanges ?? []) {
              const cidr = r.CidrIp ?? '';
              const open = cidr === '0.0.0.0/0';
              const vpcHit = open ? null : vpcs.cidrs.find((v) => v.cidr === cidr);
              // peerLabel은 표시용 비-i18n 값만(CIDR/VPC명). internet은 peerKind로 클라가 번역.
              out.push({
                ...base, peer: cidr,
                peerKind: open ? 'internet' : 'cidr',
                peerLabel: open ? cidr : vpcHit ? `${cidr} (${vpcHit.label})` : cidr,
                description: r.Description ?? null, open,
              });
            }
            for (const r of p.Ipv6Ranges ?? []) {
              const cidr = r.CidrIpv6 ?? '';
              const open = cidr === '::/0';
              out.push({
                ...base, peer: cidr, peerKind: open ? 'internet' : 'cidr',
                peerLabel: cidr,
                description: r.Description ?? null, open,
              });
            }
            for (const r of p.UserIdGroupPairs ?? []) {
              out.push({
                ...base, peer: r.GroupId ?? '', peerKind: 'sg',
                peerLabel: label(r.GroupId ?? ''),
                description: r.Description ?? null, open: false,
              });
            }
            for (const r of p.PrefixListIds ?? []) {
              const pl = r.PrefixListId ?? '';
              const plName = plNames.get(pl);
              out.push({
                ...base, peer: pl, peerKind: 'pl',
                peerLabel: plName ? `${pl} (${plName})` : pl,
                description: r.Description ?? null, open: false,
              });
            }
          }
          return out;
        };

        const rows = sgs.map((g): SgUsageRow => {
          const id = g.GroupId ?? '';
          const att = eniByGroup.get(id);
          const refs = [...(referencedBy.get(id) ?? [])].map(label);
          const rules = [...toRules(g.IpPermissions ?? [], 'ingress'), ...toRules(g.IpPermissionsEgress ?? [], 'egress')];
          const ingress = rules.filter((r) => r.direction === 'ingress');
          nextDetail.set(id, {
            region, vpcId: g.VpcId ?? '',
            eniIds: att?.ids ?? [], ips: att?.ips ?? [],
            rules,
            flowLogGroup: flowByVpc.get(g.VpcId ?? '') ?? null,
          });
          const isDefault = g.GroupName === 'default';
          return {
            id, name: g.GroupName ?? id, description: g.Description ?? '',
            region, vpcId: g.VpcId ?? '',
            vpcLabel: vpcs.byId.get(g.VpcId ?? '') ?? g.VpcId ?? '',
            isDefault,
            eniCount: att?.ids.length ?? 0,
            attachedKinds: [...(att?.kinds ?? new Map<string, number>()).entries()]
              .map(([kind, count]) => ({ kind, count }))
              .sort((a, b) => b.count - a.count),
            referencedBy: refs,
            ingressRules: ingress.length,
            egressRules: rules.length - ingress.length,
            openIngress: ingress.filter((r) => r.open).length,
            // default SG는 AWS가 삭제를 막아 "정리 후보"로 세면 오탐(리뷰 MAJOR) — 매 VPC마다
            // 항상 존재해 상시 발생하는 거짓 경고였다. isDefault는 별도 필드로 노출해 클라가
            // "기본 — 삭제 불가"로 구분 표시.
            unused: !isDefault && (att?.ids.length ?? 0) === 0 && refs.length === 0,
            rules,
          };
        });
        return { rows, flowLogVpcs: flowByVpc.size, degraded: eniTruncated };
      } catch { return { rows: [] as SgUsageRow[], flowLogVpcs: 0, degraded: true }; }
    }));

    const rows = perRegion.flatMap((r) => r.rows);
    // 완전 적재된 Map을 원자 교체 — 지연 peer 조회가 항상 완성본만 보게 한다.
    detailCache = nextDetail;
    ipLabelCache = nextIpLabel;
    return {
      rows,
      totals: {
        total: rows.length,
        attached: rows.filter((r) => r.eniCount > 0).length,
        unused: rows.filter((r) => r.unused).length,
        referencedOnly: rows.filter((r) => r.eniCount === 0 && r.referencedBy.length > 0).length,
        openIngress: rows.reduce((s, r) => s + r.openIngress, 0),
        enis: rows.reduce((s, r) => s + r.eniCount, 0),
      },
      flowLogVpcs: perRegion.reduce((s, r) => s + r.flowLogVpcs, 0),
      degradedRegions: perRegion.flatMap((r, i) => (r.degraded ? [regions[i]] : [])),
    };
  });
}

// ── 히트 매칭 ────────────────────────────────────────────────────────────────
/** hits=null = 구조적으로 매칭 불가한 룰(pl, IPv6 CIDR) — idle(정리 후보)로 세지 않음. */
export interface SgRuleHit extends SgRule { hits: number | null; bytes: number }
export interface SgPeerTraffic {
  ip: string;
  /** IP 식별 (ENI 분류 or NFM instance/subnet) — 모르면 null. */
  label: string | null;
  port: string | null;
  action: string | null; // ACCEPT/REJECT (flow logs만)
  count: number; bytes: number;
}
/** 표시 문자열은 클라이언트가 tt()로 해석 — 서버는 코드만 반환 (i18n). */
export type SgHitNote =
  | 'sg_not_found' | 'no_eni' | 'no_source'
  | 'flow_no_records' | 'flow_eni_truncated' | 'flow_capped'
  | 'nfm_peers_only' | null;
export interface SgHitsResult {
  source: 'flowlogs' | 'nfm' | 'none';
  note: SgHitNote;
  /** 인바운드 룰별 매칭 — flowlogs만 산출(정확). NFM 폴백에선 전부 hits=null(룰 귀속 불가). */
  ruleHits: SgRuleHit[];
  /** 기간 내 매칭 0인 인바운드 룰 수 (hits=null 룰은 제외). */
  idleIngressRules: number;
  peers: SgPeerTraffic[];
  rangeSec: number;
}

const isV6 = (s: string): boolean => s.includes(':');
/** matchRule이 구조적으로 판정 가능한 룰인지 — pl/IPv6 CIDR은 해석 불가(hits=null 처리). */
const ruleMatchable = (r: SgRule): boolean =>
  r.peerKind !== 'pl' && !(r.peerKind === 'cidr' && isV6(r.peer));

/** 인바운드 룰 매칭 (Flow Logs 전용) — srcIp는 실제 유입 소스 IP. */
const matchRule = (rule: SgRule, port: number | null, protoNum: string | null, srcIp: string | null, detailOf: (sgId: string) => SgDetail | undefined): boolean => {
  if (rule.direction !== 'ingress') return false;
  if (rule.protocol !== 'all' && protoNum != null && (PROTO_NAME[protoNum] ?? protoNum) !== rule.protocol) return false;
  if (rule.fromPort != null && rule.fromPort !== -1) {
    if (port == null || port < rule.fromPort || port > (rule.toPort ?? rule.fromPort)) return false;
  }
  // 0.0.0.0/0은 IPv4 소스만, ::/0은 IPv6 소스만 — 패밀리 불일치 이중 계상 방지.
  if (rule.peerKind === 'internet') return srcIp != null && isV6(srcIp) === isV6(rule.peer);
  if (rule.peerKind === 'cidr') return srcIp != null && !isV6(rule.peer) && ipInCidr(srcIp, rule.peer);
  if (rule.peerKind === 'sg') {
    const peerDetail = detailOf(rule.peer);
    return srcIp != null && (peerDetail?.ips.includes(srcIp) ?? false);
  }
  return false; // pl — 프리픽스 리스트 엔트리 해석은 범위 밖 (ruleMatchable로 이미 null 처리)
};

async function runInsights(region: string, group: string, query: string, rangeSec: number): Promise<Record<string, string>[]> {
  const end = Math.floor(Date.now() / 1000);
  const { queryId } = await logs(region).send(new StartQueryCommand({
    logGroupName: group, queryString: query, startTime: end - rangeSec, endTime: end, limit: 1000,
  }));
  if (!queryId) return [];
  for (let i = 0; i < 40; i++) {
    const res = await logs(region).send(new GetQueryResultsCommand({ queryId }));
    if (res.status === 'Complete') {
      return (res.results ?? []).map((row) =>
        Object.fromEntries(row.filter((f) => f.field && f.field !== '@ptr').map((f) => [f.field as string, f.value ?? ''])));
    }
    if (res.status === 'Failed' || res.status === 'Cancelled' || res.status === 'Timeout') throw new Error(`Insights ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  await logs(region).send(new StopQueryCommand({ queryId })).catch(() => {});
  throw new Error('Insights poll cap');
}

/** 선택 SG의 트래픽 히트 매칭 — flow logs 우선, NFM 폴백 (모두 없으면 none). */
export async function sgHits(sgId: string, rangeSec: number): Promise<SgHitsResult> {
  return cached(`h|${sgId}|${rangeSec}`, async () => {
    await sgAnalysis(); // detailCache 채움 (캐시면 no-op)
    const detail = detailCache.get(sgId);
    const empty: SgHitsResult = { source: 'none', note: null, ruleHits: [], idleIngressRules: 0, peers: [], rangeSec };
    if (!detail) return { ...empty, note: 'sg_not_found' };
    const ingress = detail.rules.filter((r) => r.direction === 'ingress');
    // 매칭 가능 룰만 hits=0으로 시작(pl/IPv6 CIDR은 null=n/a), idle 카운트는 hits===0만.
    // 실제 조회를 하고 매칭이 안 나온 경우에만 쓴다 — "증거가 아예 없음"(ENI 없음/소스 없음/
    // 레코드 0건)에는 쓰면 안 된다(리뷰 MAJOR: 근거 없는 idle 확정).
    const initRuleHits = (): SgRuleHit[] => ingress.map((r) => ({ ...r, hits: ruleMatchable(r) ? 0 : null, bytes: 0 }));
    // 증거 없음 — 매칭 가능 룰도 hits=null(확인 불가)로 둔다. idle(정리 후보) 오판 방지.
    const nullRuleHits = (): SgRuleHit[] => ingress.map((r) => ({ ...r, hits: null, bytes: 0 }));
    const idleCount = (rh: SgRuleHit[]) => rh.filter((r) => r.hits === 0).length;
    if (detail.eniIds.length === 0) {
      return { ...empty, note: 'no_eni', ruleHits: nullRuleHits(), idleIngressRules: 0 };
    }
    const ownIps = new Set(detail.ips);

    // ① VPC Flow Logs (CWL) — 룰-레벨 정확 매칭 (인바운드만)
    if (detail.flowLogGroup) {
      try {
        // 기본 포맷 space-separated 원문 — parse로 14필드 추출 (커스텀 포맷이면 0행 → 정직 폴백).
        // 방향: ENI flow log엔 아웃바운드(srcaddr=자기 IP) 레코드도 있으므로 dstaddr가 자기 IP인
        // 행(=인바운드)만 룰 매칭 — 아웃바운드 오매칭·자기 IP peer·intra-SG 이중 집계 방지.
        const truncated = detail.eniIds.length > 50;
        const eniList = detail.eniIds.slice(0, 50).map((id) => `'${id}'`).join(', ');
        const rows = await runInsights(detail.region, detail.flowLogGroup, `parse @message '* * * * * * * * * * * * * *' as version, account, interfaceId, srcaddr, dstaddr, srcport, dstport, protocol, packets, bytes, startt, endt, action, logStatus
| filter interfaceId in [${eniList}]
| stats sum(bytes) as bytes, count(*) as cnt by srcaddr, dstaddr, dstport, protocol, action
| sort cnt desc
| limit 200`, rangeSec);
        const ruleHits = initRuleHits();
        const peers: SgPeerTraffic[] = [];
        for (const row of rows) {
          const src = row.srcaddr ?? null;
          const dst = row.dstaddr ?? null;
          // 인바운드 판정: 목적지가 이 SG의 ENI IP여야 유입 트래픽 (아웃바운드/통과 레코드 제외).
          if (!dst || !ownIps.has(dst) || !src || ownIps.has(src)) continue;
          const port = row.dstport ? Number(row.dstport) : null;
          const proto = row.protocol ?? null;
          const c = Number(row.cnt) || 0;
          const b = Number(row.bytes) || 0;
          if (row.action === 'ACCEPT') {
            for (const rh of ruleHits) {
              if (rh.hits != null && matchRule(rh, port, proto, src, (id) => detailCache.get(id))) { rh.hits += c; rh.bytes += b; }
            }
          }
          if (peers.length < 20) {
            peers.push({ ip: src, label: ipLabelCache.get(src) ?? null, port: row.dstport ?? null, action: row.action ?? null, count: c, bytes: b });
          }
        }
        if (rows.length === 0) {
          // 레코드 자체가 0건 — "매칭 안 됨"이 아니라 "판단할 근거가 없음"이다(커스텀 로그
          // 포맷이라 parse가 전부 실패하는 경우도 이 분기로 떨어짐). idle 확정 금지.
          return { source: 'flowlogs' as const, note: 'flow_no_records', ruleHits: nullRuleHits(), idleIngressRules: 0, peers, rangeSec };
        }
        // Insights `limit 200`은 우리 상한(API 제약 아님) — SG의 저용량 룰 매칭이 상위
        // 200 튜플에 못 들면 조용히 hits=0(=idle)으로 오판된다(리뷰 MAJOR). 캡에 물리면
        // 매칭 가능 룰 중 관측된 매칭이 없는(hits===0) 항목만 null(확인 불가)로 강등 —
        // 실제로 카운트된 매칭(hits>0)은 그대로 신뢰.
        const capped = rows.length === 200;
        const finalHits = capped ? ruleHits.map((r) => (r.hits === 0 ? { ...r, hits: null } : r)) : ruleHits;
        return {
          source: 'flowlogs' as const,
          note: truncated ? 'flow_eni_truncated' : capped ? 'flow_capped' : null,
          ruleHits: finalHits,
          idleIngressRules: idleCount(finalHits),
          peers, rangeSec,
        };
      } catch { /* Insights 실패 → NFM 폴백 시도 */ }
    }

    // ② NFM 폴백 — 트래픽 "상대 식별"만 (NFM은 양방향 바이트 집계라 인바운드 룰 귀속 불가).
    // 룰 매칭은 하지 않고 hits=null로 두어 거짓 idle(정리 후보) 신호를 내지 않는다.
    try {
      const st = await nfmStatus();
      const monitor = st.monitors.find((m) => m.status === 'ACTIVE' && !m.cluster) ?? st.monitors.find((m) => m.status === 'ACTIVE');
      if (monitor) {
        const window = Math.min(rangeSec, NFM_MAX_RANGE_SEC);
        // 전 카테고리 (인터넷/미분류 포함) — 상대 식별 누락 방지.
        const results = await Promise.all(NFM_CATEGORIES.map((c) =>
          nfmTopContributors(monitor.name, 'DATA_TRANSFERRED', c, window, 50).catch(() => ({ rows: [], unit: '', tookMs: 0 }))));
        const byPeer = new Map<string, SgPeerTraffic>();
        for (const flow of results.flatMap((r) => r.rows)) {
          const localIsSg = flow.local.ip != null && ownIps.has(flow.local.ip);
          const remoteIsSg = flow.remote.ip != null && ownIps.has(flow.remote.ip);
          if (!localIsSg && !remoteIsSg) continue;
          const peerEp = localIsSg ? flow.remote : flow.local;
          const peerIp = peerEp.ip ?? null;
          if (!peerIp || ownIps.has(peerIp)) continue;
          const bytes = flow.value ?? 0;
          const cur = byPeer.get(peerIp) ?? {
            ip: peerIp,
            label: ipLabelCache.get(peerIp) ?? (peerEp.instanceId ? `EC2: ${peerEp.instanceId}` : peerEp.subnetId ?? null),
            port: flow.targetPort != null ? String(flow.targetPort) : null,
            action: null, count: 0, bytes: 0,
          };
          cur.count += 1; cur.bytes += bytes;
          byPeer.set(peerIp, cur);
        }
        const peers = [...byPeer.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 20);
        // ruleHits는 전부 null(NFM은 룰 귀속 불가) — idle 신호 억제, 룰 목록은 참고용 표시.
        const ruleHits: SgRuleHit[] = ingress.map((r) => ({ ...r, hits: null, bytes: 0 }));
        return { source: 'nfm' as const, note: 'nfm_peers_only', ruleHits, idleIngressRules: 0, peers, rangeSec: window };
      }
    } catch { /* NFM도 불가 → none */ }

    return { ...empty, note: 'no_source', ruleHits: nullRuleHits(), idleIngressRules: 0 };
  });
}
