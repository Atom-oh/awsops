# AWSops v2 — Frontend Modern Redesign Design

**Status:** Accepted (user chose "modern new design"; co-agent panel kiro+codex+gemini, Claude chair). 2026-06-08.

**Goal:** Replace the v2 thin-BFF's hand-rolled inline-styled MVP UI (48px top-nav + bare stat cards) with a **modern dashboard design system + app shell**, so the rich v2 backend (22 inventory types, agents, workers, cost/EKS) is presented like a real ops console — without verbatim-copying v1.

**Non-goal:** Porting v1's exact look. New, clean, modern. Backend/data unchanged.

---

## Decisions (co-agent validated)

- **DD1 = A — Tailwind CSS + shadcn/ui** (unanimous). Build-time CSS → standalone ARM64 Docker safe (PostCSS at `next build`, output in `.next/static`, already COPYed by the Dockerfile). shadcn = copy-in source on Radix primitives (no runtime lock-in, accessible). Theme via CSS variables in `globals.css`.
- **DD2 = C — collapsible left sidebar + slim top bar + Cmd-K command palette** (2/3; sidebar unanimous). 22 inventory types need hierarchy a top-nav can't hold. Cmd-K (`cmdk` via shadcn `<CommandDialog>`) indexes the inventory registry + fixed pages — cheap because the registry already enumerates everything. (codex's "stabilize routes first" caution absorbed: build the sidebar core first, Cmd-K as a thin add-on in the same shell.)
- **DD3 = A — recharts** (2/3). Composes with shadcn (pure charting, no overlapping component lib; tremor would create a 2nd design system). **Charts are deferred** — inventory dashboard is tables+cards; recharts is the chosen lib for when Overview/Cost trends are added (F2+).
- **DD4 = B — shell + design-system first, then retrofit pages incrementally** (unanimous). Lower blast radius, continuous deploy.

---

## Theme tokens (carry the existing dark palette into shadcn CSS variables)

Reuse the current inline palette so the new design feels continuous, mapped to shadcn's HSL variable contract in `globals.css` `:root` (dark-only — it's an ops console):

| role | hex | shadcn var |
|------|-----|-----------|
| background | `#0a0e1a` | `--background` |
| card/panel | `#0f1629` | `--card`, `--popover` |
| border/input | `#1a2540` | `--border`, `--input` |
| foreground | `#e6eefb` | `--foreground`, `--card-foreground` |
| muted-foreground | `#7da2c9` | `--muted-foreground` |
| primary (accent) | `#00d4ff` | `--primary` (foreground `#06121f`) |
| muted bg | `#121c33` | `--muted`, `--secondary`, `--accent` |
| destructive | `#ef4444` | `--destructive` |
| ring | `#00d4ff` | `--ring` |

Semantic status colors (success `#00ff88`, warning `#f59e0b`, info `#00d4ff`, purple `#a855f7`) exposed as Tailwind theme extension `colors.status.*` for stat cards / badges. `--radius: 0.5rem`.

---

## Architecture

### Foundation (F1a)
- Add devDeps: `tailwindcss`, `postcss`, `autoprefixer`, `tailwindcss-animate`. Add deps: `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `cmdk`, and the Radix primitives the chosen shadcn components need (`@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-tooltip`, `@radix-ui/react-separator`, `@radix-ui/react-scroll-area`, `@radix-ui/react-slot`).
- `tailwind.config.ts` (content globs over `app/**`, `components/**`; theme extends with the tokens + `tailwindcss-animate`), `postcss.config.mjs` (tailwindcss + autoprefixer), `app/globals.css` (`@tailwind base/components/utilities` + the `:root` token block + base body styles). Import `globals.css` in `app/layout.tsx`.
- `lib/utils.ts` → `cn()` (clsx + tailwind-merge). shadcn primitives copied into `components/ui/` (NOT via the network CLI — author the files directly): `button.tsx`, `card.tsx`, `table.tsx`, `badge.tsx`, `input.tsx`, `dialog.tsx`, `command.tsx`, `separator.tsx`, `tooltip.tsx`, `scroll-area.tsx`, `dropdown-menu.tsx`. (Standard shadcn source, themed by the CSS vars.)
- **Build gate (critical):** `npm run build` must stay clean and `.next/static` must contain the Tailwind CSS; the standalone Docker build must still succeed (verified at deploy).

### App shell (F1b)
- `components/shell/Sidebar.tsx` — collapsible left sidebar (`'use client'`): brand "AWSops", fixed links (Overview `/`, EKS `/eks`, Jobs `/jobs`, Cost `/cost`) each with a lucide icon; then the inventory groups from `inventoryGroups()` (Compute/Storage&DB/Network/Security/Monitoring), each group a collapsible section listing its types → `/inventory/<type>` with a group icon. Active state via `usePathname` (`===` for leaf, `startsWith('/inventory/')` for the inventory parent). Collapse toggle → icon-only (w-16) ↔ expanded (w-60), persisted in `localStorage`.
- `components/shell/TopBar.tsx` — slim bar: current page title (derived from path/registry), a region/account chip (`ap-northeast-2 · 180294183052` — static for now), a Cmd-K trigger button (`⌘K`), and a user chip (`admin`).
- `components/shell/CommandPalette.tsx` — `'use client'` shadcn `<CommandDialog>` opened by ⌘K/Ctrl-K (global keydown) or the TopBar trigger; lists the fixed pages + all 22 inventory types (from the registry) grouped; selecting routes via `next/navigation`.
- `app/layout.tsx` — compose: `<div className="flex"> <Sidebar/> <div className="flex-1"> <TopBar/> <main>{children}</main> </div> </div> <ChatDrawer/> <CommandPalette/>`. Replaces the old `<TopNav/>` (delete `components/shell/TopNav.tsx`). Body class from globals (bg-background text-foreground).

### Shared component retrofit (F1c) — highest leverage
Retrofitting the 3 shared `components/ui` primitives upgrades **every** page at once (Overview + 22 inventory + EKS/Jobs/Cost all consume them):
- `StatCard.tsx` → shadcn `<Card>` with a lucide icon, label (muted), big value, accent ring/dot. Keep the same props (`label`, `value`, `accent`) so callers are unchanged.
- `DataTable.tsx` → shadcn `<Table>` (Card-wrapped, sticky header, zebra/hover rows, empty-state). Keep the same props (`columns`, `rows`). Boolean cells render as a colored badge; long values truncate with title.
- `RefreshButton.tsx` → shadcn `<Button>` (primary) + lucide `RotateCw` (spin while busy) + a muted "updated …" timestamp with stale styling. Keep props (`busy`, `onClick`, `capturedAt`).

### Overview retrofit (F1d)
- `app/page.tsx` → grid of the new StatCards with lucide icons; section heading; loading/error states styled with the new tokens. (Validates the system end-to-end.)

### F2+ (later waves, out of F1)
Page-specific polish: chat drawer restyle to the design system; recharts on Overview (jobs/cost trends) + Cost page; EKS/Jobs page detail polish; responsive/mobile sidebar drawer; Cmd-K fuzzy actions (trigger refresh, etc.); accessibility pass (the F1 dropdown→sidebar already fixes the earlier hover-only a11y issue).

---

## Testing
- Unit (vitest): existing 47 must stay green (the ui retrofits keep prop signatures, so page/route tests are unaffected; registry/nav tests updated if nav moves to the sidebar). Add a light test for `cn()` and that `CommandPalette`/`Sidebar` import the registry without error. The jsdom env must tolerate the new components (no real Radix portal in tests — keep tests at the lib/route level, not rendering the shell).
- Build gate: `npm run build` clean + `.next/static` has Tailwind CSS + all routes present.
- Live (controller deploy): `make deploy` → `/api/health` 200 → browser: new sidebar + Cmd-K + restyled Overview/inventory render correctly behind auth; existing data still loads (the BFF/API layer is untouched).

## Rollout
F1 = foundation + shell + shared-component retrofit + Overview (one deployable wave, upgrades all pages visually). F2+ = per-page polish + charts + chat restyle. All under `web/`; no Terraform/backend change (pure presentation) — `make deploy` only.
