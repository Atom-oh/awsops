# Integration workflows

## Outcome

Operators can connect an observability source, verify the settings they intend to
use, customize a diagnostic agent, and prepare a report for colleagues or a
specialist review. Stored credentials, verified connectivity, and external
delivery are distinct states.

## Existing behavior and defects

- The datasource test ignores saved instance credentials and settings. Its
  credential spread can override the endpoint previously checked by the BFF.
- The list treats every default instance as connected and hides database failures
  as an empty list.
- Datadog validates its API key without validating its application key.
- Connector cards represent credential storage, not runtime availability.
  Notion supports reads; Slack delivery remains governed and gated; Confluence
  has no implemented dedicated publishing connector.
- Custom agents and skills have existing registration, account scope and runtime
  resolution. Fix their actual registration-to-use gaps rather than adding an
  independent agent registry.

## Design

Retain existing routes, Aurora records, secret storage and Lambda transports.
An optional datasource instance ID lets the administrator test with saved
credentials only for the unchanged endpoint. Explicit candidate credentials and
validated settings determine the test. Unknown fields cannot change transport
configuration, and errors cannot echo upstream secrets.

Provider defaults make Datadog's two headers and Dynatrace's API token explicit.
Changing connection fields invalidates prior or pending test results. Listing
configuration does not claim a successful network probe.

Report handoff uses the existing ownership-checked artifact read. Build bounded,
redacted drafts for Notion, Slack, wiki/Confluence, DevOps investigation, security
review and FinOps review. Preserve report scope, observation period, evidence
limits and an authenticated report reference. Users preview and copy/download;
there is no background publication or external agent invocation.

Improve existing custom-agent and skill validation, enabled-state visibility and
account assignment. Agent registration does not install code or grant tools.

## Constraints

No AWS-resource mutation, arbitrary MCP registration, feature-gate enablement,
credential exposure, or external messages. No migration or new service is needed.
Keep application localization and multilingual user guides. Developer documents
are English-only. Code, accepted ADRs and deployment observations remain separate.

## Verification

Reproduce connection-test and registration defects before changing code. Run
focused route, credential, resolver, report ownership and UI tests; test Datadog
with offline HTTP mocks. Render the integration and report flows on desktop and
mobile with local fixtures. Run the production build and required CI. Merge only
after complete AI review of the latest HEAD and passing mandatory checks.
