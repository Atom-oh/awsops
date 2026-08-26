<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 0d1c5dd2af19 · generated-at: 2026-08-26 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Decisions — Reviewer Context

**Current truth = `BASELINE.md`** + the consolidated ADRs in this directory (`0NN-*.md`, highest
currently **020**). Old ADR 001–046 bodies are not in the tree (git tag
`adr-legacy-2026-06-22`) — never read them without an explicit request; resolve legacy numbers
via `ADR-MAPPING.md`.

## Review checklist
1. A new ADR = highest number + 1, single Status (Accepted), and **must update `BASELINE.md`
   §3 (or §2) in the same PR** — an ADR without that update is "not live" (anti-drift).
2. BASELINE §1/§2 is the deterministic source for read-only definitions and freeze/gate status
   — don't take a single ADR's prose over it if they conflict.
3. AWS resource mutation/autonomy is FROZEN (ADR-005). Relaxing it requires a new ADR + multi-AI
   panel + a dated owner-override — never a docs-only PR.
4. Bar for ADR content: "can an AI block/pass a PR from reading this document alone?"

## Known false-positives
- A consolidated ADR citing a legacy number as `ADR-0NN[legacy 0XX]` is the documented
  convention, not a typo.
- Frozen-but-present substrate (e.g. remediation code) existing in the tree is intentional dark
  code — the violation is *enabling* it, not its presence.
