# API route index

Routes are implemented under `web/app/api/**/route.ts`; `/api/*` has no basePath.
This table indexes handlers, not an independent authorization specification. Read
one handler and its imported guards for request validation, ownership, admin checks,
revocation, cost and response semantics. Current auth boundaries are in
[ADR-002](decisions/002-auth-and-login.md); the edge public-path allowlist is in
`terraform/v2/foundation/edge-lambda/cognito_edge.py.tftpl`.

Heavy work goes through ownership-checked domain routes. Generic `POST /api/jobs`
accepts only noop job types. Unknown/partial/unassessed telemetry is not successful
collection. See [architecture](architecture.md) for data ownership.

Regenerate this index from exported HTTP handlers when adding/removing a route;
do not maintain a separate route count in README or agent context.

| Route | Exported methods | Implementation |
| --- | --- | --- |
| `/api/accounts/regions` | DELETE, GET, POST | [route.ts](../web/app/api/accounts/regions/route.ts) |
| `/api/accounts` | DELETE, GET, PATCH, POST | [route.ts](../web/app/api/accounts/route.ts) |
| `/api/actions/[id]` | GET, POST | [route.ts](../web/app/api/actions/[id]/route.ts) |
| `/api/actions` | GET, POST | [route.ts](../web/app/api/actions/route.ts) |
| `/api/agentcore` | GET | [route.ts](../web/app/api/agentcore/route.ts) |
| `/api/ai-usage` | GET | [route.ts](../web/app/api/ai-usage/route.ts) |
| `/api/anfw` | GET | [route.ts](../web/app/api/anfw/route.ts) |
| `/api/auth/login` | POST | [route.ts](../web/app/api/auth/login/route.ts) |
| `/api/auth/signout` | POST | [route.ts](../web/app/api/auth/signout/route.ts) |
| `/api/bedrock-metrics` | GET | [route.ts](../web/app/api/bedrock-metrics/route.ts) |
| `/api/changelog` | GET | [route.ts](../web/app/api/changelog/route.ts) |
| `/api/chat` | POST | [route.ts](../web/app/api/chat/route.ts) |
| `/api/chat/stats` | GET | [route.ts](../web/app/api/chat/stats/route.ts) |
| `/api/chat/threads/[id]` | DELETE, GET | [route.ts](../web/app/api/chat/threads/[id]/route.ts) |
| `/api/chat/threads` | DELETE, GET | [route.ts](../web/app/api/chat/threads/route.ts) |
| `/api/compliance/benchmarks` | GET | [route.ts](../web/app/api/compliance/benchmarks/route.ts) |
| `/api/compliance/run` | POST | [route.ts](../web/app/api/compliance/run/route.ts) |
| `/api/compliance/runs/[id]` | GET | [route.ts](../web/app/api/compliance/runs/[id]/route.ts) |
| `/api/compliance/runs` | GET | [route.ts](../web/app/api/compliance/runs/route.ts) |
| `/api/cost/availability` | GET | [route.ts](../web/app/api/cost/availability/route.ts) |
| `/api/cost/detail` | GET | [route.ts](../web/app/api/cost/detail/route.ts) |
| `/api/cost` | GET | [route.ts](../web/app/api/cost/route.ts) |
| `/api/customization` | GET, POST, PUT | [route.ts](../web/app/api/customization/route.ts) |
| `/api/datasources/[id]/cards` | GET | [route.ts](../web/app/api/datasources/[id]/cards/route.ts) |
| `/api/datasources/[id]/default` | POST | [route.ts](../web/app/api/datasources/[id]/default/route.ts) |
| `/api/datasources/[id]/diag-signals` | GET | [route.ts](../web/app/api/datasources/[id]/diag-signals/route.ts) |
| `/api/datasources/[id]` | DELETE | [route.ts](../web/app/api/datasources/[id]/route.ts) |
| `/api/datasources/generate` | POST | [route.ts](../web/app/api/datasources/generate/route.ts) |
| `/api/datasources/manage` | PATCH, POST | [route.ts](../web/app/api/datasources/manage/route.ts) |
| `/api/datasources/query` | POST | [route.ts](../web/app/api/datasources/query/route.ts) |
| `/api/datasources` | GET | [route.ts](../web/app/api/datasources/route.ts) |
| `/api/datasources/test` | POST | [route.ts](../web/app/api/datasources/test/route.ts) |
| `/api/db` | GET | [route.ts](../web/app/api/db/route.ts) |
| `/api/diagnosis/[id]/download` | GET | [route.ts](../web/app/api/diagnosis/[id]/download/route.ts) |
| `/api/diagnosis/[id]` | DELETE, GET, PATCH | [route.ts](../web/app/api/diagnosis/[id]/route.ts) |
| `/api/diagnosis/intent` | GET, POST | [route.ts](../web/app/api/diagnosis/intent/route.ts) |
| `/api/diagnosis/notify` | GET, PUT | [route.ts](../web/app/api/diagnosis/notify/route.ts) |
| `/api/diagnosis` | GET, POST | [route.ts](../web/app/api/diagnosis/route.ts) |
| `/api/diagnosis/schedule` | GET, PUT | [route.ts](../web/app/api/diagnosis/schedule/route.ts) |
| `/api/diagnosis/subscribers` | DELETE, GET, POST | [route.ts](../web/app/api/diagnosis/subscribers/route.ts) |
| `/api/diagnosis/subscribers/test` | POST | [route.ts](../web/app/api/diagnosis/subscribers/test/route.ts) |
| `/api/dns-logs/analytics` | GET | [route.ts](../web/app/api/dns-logs/analytics/route.ts) |
| `/api/dns-logs` | GET | [route.ts](../web/app/api/dns-logs/route.ts) |
| `/api/dx` | GET | [route.ts](../web/app/api/dx/route.ts) |
| `/api/eks/[cluster]/incluster/describe` | GET | [route.ts](../web/app/api/eks/[cluster]/incluster/describe/route.ts) |
| `/api/eks/[cluster]/incluster` | GET | [route.ts](../web/app/api/eks/[cluster]/incluster/route.ts) |
| `/api/eks/[cluster]/k8sgpt` | GET | [route.ts](../web/app/api/eks/[cluster]/k8sgpt/route.ts) |
| `/api/eks/[cluster]/metrics` | GET | [route.ts](../web/app/api/eks/[cluster]/metrics/route.ts) |
| `/api/eks/[cluster]/pod-transfer` | GET | [route.ts](../web/app/api/eks/[cluster]/pod-transfer/route.ts) |
| `/api/eks/[cluster]/register` | DELETE, POST | [route.ts](../web/app/api/eks/[cluster]/register/route.ts) |
| `/api/eks/fleet` | GET | [route.ts](../web/app/api/eks/fleet/route.ts) |
| `/api/eks/node-eni` | GET | [route.ts](../web/app/api/eks/node-eni/route.ts) |
| `/api/eks` | GET | [route.ts](../web/app/api/eks/route.ts) |
| `/api/eks/summary` | GET | [route.ts](../web/app/api/eks/summary/route.ts) |
| `/api/finops/findings` | GET | [route.ts](../web/app/api/finops/findings/route.ts) |
| `/api/graph` | GET | [route.ts](../web/app/api/graph/route.ts) |
| `/api/health` | GET | [route.ts](../web/app/api/health/route.ts) |
| `/api/incidents/[id]` | GET | [route.ts](../web/app/api/incidents/[id]/route.ts) |
| `/api/incidents/prevention` | GET | [route.ts](../web/app/api/incidents/prevention/route.ts) |
| `/api/incidents` | GET, POST | [route.ts](../web/app/api/incidents/route.ts) |
| `/api/incidents/webhook` | POST | [route.ts](../web/app/api/incidents/webhook/route.ts) |
| `/api/insights/refresh` | POST | [route.ts](../web/app/api/insights/refresh/route.ts) |
| `/api/insights` | GET | [route.ts](../web/app/api/insights/route.ts) |
| `/api/integrations/credential` | GET, PUT | [route.ts](../web/app/api/integrations/credential/route.ts) |
| `/api/integrations` | GET, POST, PUT | [route.ts](../web/app/api/integrations/route.ts) |
| `/api/integrations/schema` | GET, POST | [route.ts](../web/app/api/integrations/schema/route.ts) |
| `/api/inventory/[type]/metrics` | GET | [route.ts](../web/app/api/inventory/[type]/metrics/route.ts) |
| `/api/inventory/[type]/refresh` | POST | [route.ts](../web/app/api/inventory/[type]/refresh/route.ts) |
| `/api/inventory/[type]` | GET | [route.ts](../web/app/api/inventory/[type]/route.ts) |
| `/api/inventory/cloudtrail/events` | GET | [route.ts](../web/app/api/inventory/cloudtrail/events/route.ts) |
| `/api/inventory/ebs_volume/related` | GET | [route.ts](../web/app/api/inventory/ebs_volume/related/route.ts) |
| `/api/inventory/security_group/inbound` | GET | [route.ts](../web/app/api/inventory/security_group/inbound/route.ts) |
| `/api/inventory/summary` | GET | [route.ts](../web/app/api/inventory/summary/route.ts) |
| `/api/inventory/trend` | GET | [route.ts](../web/app/api/inventory/trend/route.ts) |
| `/api/ip-inventory` | GET | [route.ts](../web/app/api/ip-inventory/route.ts) |
| `/api/jobs/[id]` | GET | [route.ts](../web/app/api/jobs/[id]/route.ts) |
| `/api/jobs/observability` | GET | [route.ts](../web/app/api/jobs/observability/route.ts) |
| `/api/jobs` | GET, POST | [route.ts](../web/app/api/jobs/route.ts) |
| `/api/me` | GET | [route.ts](../web/app/api/me/route.ts) |
| `/api/monitoring` | GET | [route.ts](../web/app/api/monitoring/route.ts) |
| `/api/network-path-runs/[runId]` | GET | [route.ts](../web/app/api/network-path-runs/[runId]/route.ts) |
| `/api/network-paths/[id]` | DELETE, GET, PATCH | [route.ts](../web/app/api/network-paths/[id]/route.ts) |
| `/api/network-paths/[id]/runs` | GET, POST | [route.ts](../web/app/api/network-paths/[id]/runs/route.ts) |
| `/api/network-paths` | GET, POST | [route.ts](../web/app/api/network-paths/route.ts) |
| `/api/nfm/query` | GET | [route.ts](../web/app/api/nfm/query/route.ts) |
| `/api/nfm` | GET | [route.ts](../web/app/api/nfm/route.ts) |
| `/api/opencost/[cluster]/allocation` | GET | [route.ts](../web/app/api/opencost/[cluster]/allocation/route.ts) |
| `/api/opencost/[cluster]/bundle` | GET | [route.ts](../web/app/api/opencost/[cluster]/bundle/route.ts) |
| `/api/opencost/[cluster]` | GET, PUT | [route.ts](../web/app/api/opencost/[cluster]/route.ts) |
| `/api/opencost/[cluster]/status` | GET | [route.ts](../web/app/api/opencost/[cluster]/status/route.ts) |
| `/api/overview` | GET | [route.ts](../web/app/api/overview/route.ts) |
| `/api/security/refresh` | POST | [route.ts](../web/app/api/security/refresh/route.ts) |
| `/api/security` | GET | [route.ts](../web/app/api/security/route.ts) |
| `/api/sg/flow-sources` | GET, PUT | [route.ts](../web/app/api/sg/flow-sources/route.ts) |
| `/api/sg` | GET | [route.ts](../web/app/api/sg/route.ts) |
| `/api/sg/rules/refresh` | POST | [route.ts](../web/app/api/sg/rules/refresh/route.ts) |
| `/api/sg/rules` | GET | [route.ts](../web/app/api/sg/rules/route.ts) |
| `/api/stream` | GET | [route.ts](../web/app/api/stream/route.ts) |
| `/api/tgw` | GET | [route.ts](../web/app/api/tgw/route.ts) |
| `/api/vpce` | GET | [route.ts](../web/app/api/vpce/route.ts) |
