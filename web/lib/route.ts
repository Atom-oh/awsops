import { sectionByKey } from './sections';

// MVP keyword heuristics per section (KO + EN). First match wins, in this order.
const RULES: { key: string; re: RegExp }[] = [
  { key: 'cost', re: /비용|요금|예산|절감|billing|cost|budget|forecast|spend/i },
  { key: 'security', re: /보안|권한|역할|정책|iam|policy|role|denied|permission|public|노출/i },
  { key: 'network', re: /통신|연결|네트워크|포트|라우트|reachab|network|connectivity|security ?group|\bsg\b|nacl|tgw|vpn|peering|flow ?log/i },
  { key: 'container', re: /파드|컨테이너|eks|ecs|kubernetes|k8s|pod|istio|namespace|sidecar/i },
  { key: 'data', re: /쿼리|데이터베이스|rds|aurora|dynamo|elasticache|redis|msk|kafka|database|slow query|throttl/i },
  { key: 'cost', re: /\$\d/i },
  { key: 'monitoring', re: /알람|지표|로그변경|cloudwatch|cloudtrail|alarm|metric|who changed|audit/i },
  { key: 'iac', re: /드리프트|스택|terraform|cloudformation|\bcdk\b|drift|stack|iac/i },
  { key: 'observability', re: /레이턴시|트레이스|p99|latency|trace|loki|tempo|prometheus|jaeger|grafana/i },
];

/** Choose the agent gateway. A valid pin always wins; otherwise keyword-match; else 'ops'. */
export function pickGateway(prompt: string, pinned?: string): string {
  if (pinned && sectionByKey(pinned)) return pinned;
  for (const r of RULES) {
    if (r.re.test(prompt)) return r.key;
  }
  return 'ops';
}
