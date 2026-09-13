---
sidebar_position: 2
title: Custom Agents
description: Register diagnostic personas, attach reusable skills, and select them in chat
---

# Custom Agents and Skills

Open **Integrations → Agents & Skills → Custom Agents & Skills**. Management requires an administrator. An agent defines a diagnostic persona and its existing gateway; a skill supplies reusable Markdown instructions. Registration does not install code or connect an external managed agent.

## Register and use

1. In **New Agent**, enter a kebab-case name, description, persona, gateway and routing keywords. `observability` is available for the existing external-observability gateway.
2. In **New Skill**, enter a name, description and Markdown instructions. Prefer instructions that explain when to use evidence and how to disclose missing coverage.
3. New or replaced custom records are **Disabled**. Enable the skill, then select it in the agent's skill picker and attach it. The list shows attached skills in composition order.
4. Enable the agent. If the account has an **Agent Space**, include the agent in that account's selection. Its tool cap can restrict the gateway's tools; registration cannot grant new infrastructure permissions.
5. With hybrid routing available, type `/` in the assistant and select an enabled custom agent for the current account. Add your question and send it. Routing keywords also support automatic selection. Changing account scope clears a selected custom command; the server rechecks availability when sending.

Built-in records cannot be replaced or toggled from this page. Saving an existing custom name replaces its definition and leaves it disabled until reviewed and enabled again.

## Useful starting personas

| Persona | Gateway | Instructions to include |
|---|---|---|
| SRE investigation | `ops` | Cite evidence and observation time; separate hypotheses, impact and next read-only checks. |
| IAM review | `security` | Explain trust boundaries and permission evidence; disclose unassessed controls. |
| FinOps review | `cost` | Verify billing period, utilization and commitments before estimating savings. |

These are AWSops personas. AWS DevOps Agent and AWS Security Agent are separate services; registering a persona does not provision or invoke them.

## Data and knowledge connections

Use **Integrations → Datasources** for Datadog, Dynatrace and other observability endpoints. Use **Connectors** for Notion credentials and the supported hosted-MCP preparation paths. A saved credential is not verified connectivity. Arbitrary MCP endpoints and autonomous infrastructure changes are not enabled by custom-agent registration.

- [Datasource management](../observability/datasources)
- [AI Assistant](../overview/assistant)
