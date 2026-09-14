# AI investigation examples

These are manual investigation prompts, not a fixed routing oracle or guaranteed
tool sequence. Expected labels come from `web/lib/fixtures/golden-routing.json`,
`web/lib/route.ts` and the current AgentCore catalog. Use the
[AI verification guide](ai-testing.md) for executable checks.

| Investigation | Example question | Evidence to verify |
| --- | --- | --- |
| Security | Which resources have encryption or exposure findings? | Resource identity, source, scope, missing attributes and actual observations |
| Network | Show the path between these services and the observed traffic. | Separate inventory relationships, traces and network measurements; disclose gaps |
| Kubernetes | Which clusters or workloads show capacity pressure? | Cluster access, metric window, requests/limits and incomplete coverage |
| Cost | Explain this month's change by service and account. | Billing window, account scope and comparison basis; do not claim realized savings from recommendations |
| Monitoring | Which alarms are active and what changed recently? | Alarm state, timestamps, CloudTrail provenance and permissions |
| Data services | Show RDS or DynamoDB health and configuration. | Correct service data, freshness and known versus unknown fields |
| Inventory | List EC2 instances and their relevant dependencies. | Aurora snapshot provenance or supported live MCP reads; no disabled live Steampipe path |
| External observability | Find slow requests in the configured trace source. | Configured connector, query language, sampling/window limits and partial collection |
| IaC guidance | Explain the Terraform changes this finding would require. | A reviewed proposal; no autonomous apply or resource mutation |
| Incident diagnosis | What evidence supports the suspected cause? | Cited observations, alternatives and abstention when evidence conflicts or is insufficient |

Run a small representative set before broad live tests. Record configuration and
actual results rather than asserting an arbitrary response-time target. Product
language behavior and tool availability are separate from route classification.
