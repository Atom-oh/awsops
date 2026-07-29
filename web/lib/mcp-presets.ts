// web/lib/mcp-presets.ts
// ADR-017 — curated official-vendor MCP presets, surfaced as cards on the Integrations hub's
// Connectors tab (web/app/integrations/connectors/ConnectorsTab.tsx). Registering here does NOT
// create a new integration `kind` — every slug below is already a member of
// INTEGRATION_KINDS_EGRESS (web/lib/integration-validation.ts) and of KNOWN_CONNECTOR_SLUGS
// (web/lib/integration-credentials.ts); this file only adds curated UI metadata + the ADR-017
// "official MCP" framing on top of the existing egress/credential machinery.
//
// Credential shape written by ConnectorsTab is the SAME as the existing Notion flow —
// `PUT /api/integrations/credential { slug, secret: { token } }` — because
// scripts/v2/agentcore/provision.py's ensure_mcp_server_targets reads `secret[preset_key].token`
// as the single bearer/API-key value for the AgentCore Identity credential provider (see
// catalog.py MCP_SERVER_TARGETS auth.credential_parameter_name — always one header slot).
//
// SOURCE OF TRUTH lockstep (mcp-presets.test.ts): every slug here must be a member of both
// INTEGRATION_KINDS_EGRESS and KNOWN_CONNECTOR_SLUGS.
import { KNOWN_CONNECTOR_SLUGS } from '@/lib/integration-credentials';

export interface McpPreset {
  slug: (typeof KNOWN_CONNECTOR_SLUGS)[number];
  label: string;
  /** true = a vendor-official MCP server exists for this kind (ADR-017). false = kept on the
   *  existing token-connector path because no official MCP exists (n/a here — Prometheus/Mimir
   *  stay off this catalog entirely) or the official MCP is OAuth-only / hosted-3LO (Notion). */
  official: boolean;
  /** Vendor's own server/API is in preview — surfaced as a badge, not a functional gate. */
  preview?: boolean;
  help: string;
  docsUrl: string;
  readOnlyNote: string;
}

// Notion kept first (pre-existing token connector, unchanged behavior) — official hosted MCP
// exists but is OAuth-3LO-only (no headless/service-account auth), so it stays on the direct
// internal-integration-token path rather than becoming an ADR-017 mcpServer preset.
export const MCP_PRESETS: McpPreset[] = [
  {
    slug: 'notion',
    label: 'Notion',
    official: false,
    help: 'notion.so/my-integrations 에서 내부 통합을 만들고 토큰을 붙여넣으세요.',
    docsUrl: 'https://developers.notion.com/docs/get-started-with-mcp',
    readOnlyNote: '읽기 전용',
  },
  {
    slug: 'datadog',
    label: 'Datadog',
    official: true,
    help: 'Datadog 공식 MCP(mcp.datadoghq.com). API 서비스 토큰(PAT)을 발급해 붙여넣으세요.',
    docsUrl: 'https://docs.datadoghq.com/mcp_server/setup/',
    readOnlyNote: 'RBAC mcp_read',
  },
  {
    slug: 'clickhouse',
    label: 'ClickHouse',
    official: true,
    help: 'ClickHouse 공식 MCP(self-hosted). 서버가 발급한 API 토큰을 붙여넣으세요.',
    docsUrl: 'https://github.com/ClickHouse/mcp-clickhouse',
    readOnlyNote: '기본 읽기 전용',
  },
  {
    slug: 'tempo',
    label: 'Tempo',
    official: true,
    help: 'Tempo 바이너리 내장 MCP(/api/mcp). 기존 Tempo 인증 토큰을 붙여넣으세요.',
    docsUrl: 'https://grafana.com/docs/tempo/latest/api_docs/mcp-server/',
    readOnlyNote: '조회 전용 툴',
  },
  {
    slug: 'jaeger',
    label: 'Jaeger',
    official: true,
    help: 'Jaeger v2 내장 MCP(/api/ai/mcp/, ai.enable_mcp 필요). 인증 토큰을 붙여넣으세요.',
    docsUrl: 'https://github.com/jaegertracing/jaeger/blob/main/docs/adr/002-mcp-server.md',
    readOnlyNote: '읽기 전용 9개 툴',
  },
  {
    slug: 'grafana',
    label: 'Grafana',
    official: true,
    help: 'Grafana 공식 MCP(self-hosted, --disable-write). API 토큰을 붙여넣으세요.',
    docsUrl: 'https://github.com/grafana/mcp-grafana',
    readOnlyNote: '--disable-write',
  },
  {
    slug: 'dynatrace',
    label: 'Dynatrace',
    official: true,
    help: 'Dynatrace 공식 hosted MCP 게이트웨이. Platform Token을 붙여넣으세요.',
    docsUrl: 'https://docs.dynatrace.com/docs/dynatrace-intelligence/dynatrace-mcp',
    readOnlyNote: '스코프 기반 read',
  },
  {
    slug: 'splunk',
    label: 'Splunk',
    official: true,
    help: 'Splunk 공식 MCP(Splunkbase 앱 7931, self-hosted). 앱이 발급한 토큰을 붙여넣으세요.',
    docsUrl: 'https://help.splunk.com/en/splunk-cloud-platform/mcp-server-for-splunk-platform/1.1/about-mcp-server-for-splunk-platform',
    readOnlyNote: 'mcp_tool_execute만 부여',
  },
  {
    slug: 'newrelic',
    label: 'New Relic',
    official: true,
    preview: true,
    help: 'New Relic 공식 MCP(mcp.newrelic.com, Preview). 읽기 전용 User API Key를 붙여넣으세요.',
    docsUrl: 'https://docs.newrelic.com/docs/agentic-ai/mcp/overview/',
    readOnlyNote: '벤더 preview 단계',
  },
];
