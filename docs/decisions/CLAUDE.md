# Decisions — AI Guidance

**Current truth = [`BASELINE.md`](BASELINE.md)** + the consolidated ADRs in this directory
(`0NN-*.md`). Start there.

- **BASELINE.md** = north star (§0) + invariants (§1) + gate/freeze register (§2) + decision
  index (§3). The reading entry point.
- **`0NN-*.md`** = a consolidated ADR (current decision detail + why). Single Status.
- **Old ADR (001–046) bodies are not in the tree** — preserved at git tag
  `adr-legacy-2026-06-22`. Mapping: [`ADR-MAPPING.md`](ADR-MAPPING.md) (canonical — the
  `../history/` copy is a pointer stub). Restore with:
  `git show adr-legacy-2026-06-22:docs/decisions/<old-file>.md`. **Do not read the old bodies
  without an explicit request.**

## Adding a new ADR
1. Number = current highest + 1 (currently **020**).
2. Structure = Status (single, Accepted) / Context / Decision / Consequences / 6 Pillars. Do
   not narrate the reversal chain — state only the current net decision.
3. **Must update `BASELINE.md` §3 (or §2) in the same PR** — without it the ADR is "not live"
   (anti-drift).
4. Bar: "can an AI block/pass a PR from reading this document alone?"

## Rules
- BASELINE §1/§2 is the deterministic source for read-only definitions and freeze/gate status.
- AWS resource mutation/autonomy = FROZEN (ADR-005). Relaxing it requires a new ADR + multi-AI
  panel + owner-override.
