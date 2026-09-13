# UI design reference

This document describes the implemented v2 UI. The former warm-paper/orange
prototype handoff is historical; it is not a mandate to replace the current theme
or restore deleted `src/` paths. Production code lives under `web/`.

## Sources

| Concern | Source |
| --- | --- |
| Theme tokens and light/cobalt/dark palettes | `web/app/globals.css` |
| Tailwind aliases, spacing, typography and shadows | `web/tailwind.config.ts` |
| Shared UI components | `web/components/` |
| Page behavior and loading/error states | `web/app/` |
| Chart colors and data formatting | `web/lib/` and the consuming chart component |
| Architecture and feature gates | `docs/decisions/BASELINE.md` |

Use existing semantic tokens (`surface`, `ink`, `brand`, `positive`, `negative`,
`warning`, chart colors) rather than embedding a second palette. The base CSS palette uses teal and cool neutrals. The application default is cobalt
(`web/lib/theme.ts:DEFAULT_THEME`, applied by `web/app/layout.tsx`); cobalt and dark
modes override the base tokens. Preserve contrast
and native form-field appearance in all supported themes. Chart palette variables
read by `useChartColors` must hold concrete hex values: the helper reads computed
custom properties and does not resolve nested `var()` references. Section-accent
alpha tints use `color-mix`, not hex-suffix concatenation.

## Interaction and evidence

Keep labels, units, time windows, account/region scope and data provenance visible.
Use tables for exact resource comparison and charts for trends/distributions. Do not
turn an unavailable collector, unknown resource attribute or unassessed diagnostic
check into a healthy zero. Distinguish inventory relationships, observed service
calls and network evidence in topology views.

Reuse responsive layout, loading, empty and error patterns from adjacent pages.
Interactive controls need accessible names, keyboard use and visible focus. Keep
application translations; English-only developer documentation is not an instruction
to remove product i18n.

A UI change does not authorize a new AWS action or feature-gate transition. Verify
route authorization and backend semantics before adding an action button. See
`web/CLAUDE.md` and the relevant module context for implementation details.
