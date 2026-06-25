# Plan: CLAUDE.md ↔ code discrepancy sync (2026-06-25)

## Context
A doc↔implementation audit (co-agent:harness, host=Claude, implementer=Codex, panel=kiro-cli/codex/agy)
verified CLAUDE.md's concrete claims against the actual Terraform/web/agent/scripts code on
`feat/v2-architecture-design`. The docs were recently consolidated (see
`docs/reviews/2026-06-21-docs-reality-audit.md`), so almost every claim MATCHES. Two genuine
discrepancies remain — both **doc-side** (the code is correct/intentional):

1. **EKS access-entry policy name** — CLAUDE.md says the web task role gets `AmazonEKSViewPolicy`,
   but `terraform/v2/foundation/eks.tf` binds **`AmazonEKSAdminViewPolicy`** to it (intentional —
   the eks.tf comment explains `View` cannot list cluster-scoped nodes; `AmazonEKSViewPolicy` is
   used only for the separate istio-read role). The doc is factually wrong.
2. **AgentCore slice count** — CLAUDE.md says "Currently 2 read-only slices deployed
   (iam-mcp 14 tools→security, flow-monitor 1→network); full fleet is P3", but `ai.tf` now
   **defines the full ~27-slice agent-Lambda fleet** (all gated on `agentcore_enabled`, default
   false). The per-slice facts (iam-mcp 14→security, flow-monitor 1→network) are accurate; the
   "only 2" framing is stale on the TF-definition axis.

No code bugs were found. Scope is limited to `CLAUDE.md` plus one self-contained consistency test.

## Constraints
- **Doc-only changes** to `CLAUDE.md`. Do NOT touch `eks.tf`/`ai.tf` — the code is correct.
- Edit BOTH the Korean (top) and English (bottom) blocks of CLAUDE.md so they stay in sync.
- The repo's `tests/run-all.sh` baseline is RED for pre-existing, unrelated reasons
  (`docs/architecture.md` missing; root `vitest` needs root `node_modules`). Task 1's guard test
  is therefore a **self-contained bash structure test** that is provable red→green on its own,
  independent of the broken suite.

---

### Task 1: Correct the EKS access-entry policy name in CLAUDE.md
The web task role's EKS Access Entry is associated with `AmazonEKSAdminViewPolicy` (eks.tf:34),
not `AmazonEKSViewPolicy`. Fix both language blocks of CLAUDE.md to name the policy the code
actually binds, and add a self-contained consistency test that fails until the doc matches eks.tf.

**Files:**
- Modify: `CLAUDE.md`
- Test: `tests/structure/test-doc-code-consistency.sh`

- [ ] Write `tests/structure/test-doc-code-consistency.sh`: extract the `cluster-access-policy/...`
      name bound to the `aws_eks_access_entry.web` association in
      `terraform/v2/foundation/eks.tf` (expected `AmazonEKSAdminViewPolicy`), then assert that the
      CLAUDE.md "EKS onboarding" lines reference that exact policy and do NOT mis-state it as
      `AmazonEKSViewPolicy`. Pure bash + grep (TAP-style `ok`/`not ok`), no vitest/tfvars/node deps.
- [ ] In CLAUDE.md, change `AmazonEKSViewPolicy` → `AmazonEKSAdminViewPolicy` in BOTH the Korean
      EKS-onboarding line and the English EKS-onboarding line (the web task-role access entry only;
      do not alter any text describing the separate istio-read `AmazonEKSViewPolicy` role).
- [ ] Run `bash tests/structure/test-doc-code-consistency.sh` → green.

### Task 2: Reconcile the AgentCore slice-count line in CLAUDE.md
Reword the "Currently 2 read-only slices deployed … full fleet is P3" claim so it is accurate
about the Terraform definition without overstating live deployment. `ai.tf`'s `agent_lambdas`
`for_each` defines the full ~27-slice fleet gated on `agentcore_enabled` (default false → $0 /
not live until enabled); the iam-mcp(14→security)/flow-monitor(1→network) read-only slice is the
P1f-era deployment.

**Files:**
- Modify: `CLAUDE.md`

- [ ] Reword the AgentCore slice sentence in BOTH language blocks to distinguish the TF-defined
      fleet (`ai.tf` defines the full ~27-slice agent-Lambda fleet, `agentcore_enabled`-gated)
      from the read-only iam-mcp/flow-monitor slice, keeping the accurate per-slice tool counts
      (iam-mcp 14→security, flow-monitor 1→network) and the P3 "full fleet" framing.
- [ ] (test_required:false — judgment doc edit; correctness is verified by the consensus gate, not
      a unit test, since "deployed-live vs TF-defined" is not mechanically assertable here.)
