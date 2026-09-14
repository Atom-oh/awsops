# Components

Use root [CLAUDE.md](../../CLAUDE.md),
[BASELINE.md](../../docs/decisions/BASELINE.md), and [web context](../CLAUDE.md).
Reuse current `ui/` primitives and inspect their prop types before adding variants.

- Page-facing components normally export default. Shared utilities/hooks and
  components such as `StackBar` in `eks/NodeCapacityCards.tsx` also have named
  exports; preserve these public interfaces.
- `ui/StatCard.tsx` aliases `StatTile`; new code should use `StatTile`. Follow its
  typed variants and compatibility props, not the deleted StatsCard color rules.
  Theme tokens come from the current web styles/configuration.
- `ui/DataTable.tsx` and `ui/DetailPanel.tsx` provide list/detail primitives.
  New inventory types define grouped `sections` in `lib/inventory-types.ts`.
  `inventory/metrics/MetricTable.tsx` supplies declarative sorting/filtering;
  preserve full search data when applying render caps.
- `shell/LanguageProvider.tsx` exposes `useI18n()` (`t`, `tt`, `lang`). Existing
  Korean-source UI prose and translation maps stay intact. Technical table
  headers and inventory column/facet/section identifiers intentionally stay
  English. Update affected guide translations together when changing guide content.
- Preserve chat stream buffering and completion flushing in `chat/useChat.ts`
  and `MessageList.tsx`. Modals inside the transformed sidebar portal to `body`
  (`shell/ChangelogVersion.tsx`).
- Keep loading, error, empty, and partial-data states distinct. Do not present
  missing measurements as zero or rely on color alone to convey status.

Run affected colocated `*.test.tsx` tests and the production web build when
relevant. English-only documentation does not change app i18n.
