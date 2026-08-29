# Datasource Dashboard Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On datasource registration (and every daily index run), pre-build an expected dashboard-card set from the cached schema with each card's query stored, and render it as a live-executing card dashboard on `/integrations/datasources/[id]`.

**Architecture:** Third pre-built-content family alongside `datasource_diag_signals` and `datasource_graph_queries`: a pure `card_catalog.py` builder + `db.py` helpers + a `_rebuild_dashboard_cards` step in `datasource_index.py` (schema-hash skip, atomic upsert+sweep, empty-build sentinel, NO LLM/budget machinery), read by a thin BFF route and rendered by a `CardDashboard` client component that executes stored queries through the existing `POST /api/datasources/query`.

**Tech Stack:** Python worker (pg8000-style `conn.run`), Next.js 14 client components, vitest, pytest-style worker tests (run via `python3 -m pytest scripts/v2/workers/test_card_catalog.py` — match how the neighboring `test_datasource_index.py` is invoked; check its header for the exact runner).

**Spec:** `docs/superpowers/specs/2026-08-28-datasource-dashboard-cards-design.md`

## Global Constraints

- Worktree `.claude/worktrees/datasource-cards`, branch `feat/datasource-dashboard-cards` (base `origin/main`). Web commands run from `<worktree>/web/`, worker tests from `<worktree>/scripts/v2/workers/`.
- NEVER edit `terraform/v2/foundation/data/schema.sql` (frozen) — new table = new ULID migration in `terraform/v2/foundation/migrations/`.
- `card_catalog.py` is PURE: no DB, no boto3, no egress. Expressions are module constants; the only schema-derived splice is the validated ClickHouse table identifier.
- Cards are deterministic-only: no LLM, no budget rows. Empty build writes the `__schema_version__` sentinel (diag-signal pattern), which the BFF read excludes.
- Korean UI strings through `tt()` (`useI18n`); all components `export default`; fetch `/api/*`.
- Commit after every green test cycle.

---

### Task 1: Migration — `datasource_dashboard_cards`

**Files:**
- Create: `terraform/v2/foundation/migrations/<ULID>_datasource_dashboard_cards.sql`

**Interfaces:**
- Produces: the table every later task reads/writes. Columns exactly as below.

- [ ] **Step 1: Generate the ULID filename**

```bash
python3 - <<'EOF'
import time, os
enc='0123456789ABCDEFGHJKMNPQRSTVWXYZ'
def b32(n, l):
    s=''
    for _ in range(l): s=enc[n&31]+s; n>>=5
    return s
print(b32(int(time.time()*1000),10)+b32(int.from_bytes(os.urandom(10),'big'),16))
EOF
```

Confirm it sorts AFTER the newest existing file in `terraform/v2/foundation/migrations/` (`ls | tail`).

- [ ] **Step 2: Write the migration** (`-- since:` header names the CURRENT unreleased version line, matching the newest neighboring migration's convention — read one first)

```sql
-- Datasource dashboard cards: schema-driven pre-built card set with stored queries
-- (docs/superpowers/specs/2026-08-28-datasource-dashboard-cards-design.md).
-- Third pre-built-content family next to datasource_diag_signals / datasource_graph_queries:
-- built by scripts/v2/workers/datasource_index.py from the cached schema, read by
-- GET /api/datasources/[id]/cards, executed live at view time via POST /api/datasources/query.
-- Deterministic catalog only — no LLM rows, so no budget/provenance machinery.
CREATE TABLE IF NOT EXISTS datasource_dashboard_cards (
  account_id     text NOT NULL DEFAULT 'self',
  integration_id bigint NOT NULL,
  card_key       text NOT NULL,
  title          text NOT NULL,
  viz            text NOT NULL,
  unit           text NOT NULL DEFAULT '',
  status         text NOT NULL,
  query          jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing        jsonb NOT NULL DEFAULT '[]'::jsonb,
  schema_version text NOT NULL DEFAULT '',
  built_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, integration_id, card_key)
);
```

- [ ] **Step 3: Commit**

```bash
git add terraform/v2/foundation/migrations/*_datasource_dashboard_cards.sql
git commit -m "feat(data): datasource_dashboard_cards migration"
```

---

### Task 2: `card_catalog.py` — pure card builder (TDD)

**Files:**
- Create: `scripts/v2/workers/diagnosis/card_catalog.py`
- Test: `scripts/v2/workers/test_card_catalog.py`

**Interfaces:**
- Produces (used by Tasks 3–4):
  - `CARD_CATALOG_VERSION: str` (start `"v1"`)
  - `build_cards(kind: str, schema: dict | None) -> list[dict]` — each row:
    `{"card_key": str, "title": str, "viz": "stat"|"timeseries"|"table", "unit": str, "status": "ready"|"unavailable", "query": {"tool": str, "expr": str, "range": {"window": int, "step": int} | None} | None, "missing": list[str]}`
    Unknown kind or `schema is None` → `[]`.

Schema shapes (from `datasource_schemas`, see registry-graph-sources spec): prometheus/mimir
`{metrics: [...], labels: [...]}`; loki `{labels: [...]}`; tempo `{tags: [...]}`; clickhouse
`{tables: [{name, columns: [{name, type}]}]}`.

- [ ] **Step 1: Write the failing tests** (`scripts/v2/workers/test_card_catalog.py` — mirror `test_datasource_index.py`'s import bootstrap, e.g. `sys.path.insert` of the workers dir + `diagnosis` dir, whichever it uses)

```python
import card_catalog as cc  # adjust import to match how signal_catalog is imported in neighboring tests


def test_prometheus_ready_and_unavailable_split():
    schema = {"metrics": ["up", "node_cpu_seconds_total"], "labels": []}
    rows = cc.build_cards("prometheus", schema)
    by = {r["card_key"]: r for r in rows}
    assert by["up_targets"]["status"] == "ready"
    assert by["up_targets"]["query"]["tool"] == "prometheus_query"
    assert by["cpu_usage"]["status"] == "ready"
    assert by["memory_available"]["status"] == "unavailable"
    assert "node_memory_MemAvailable_bytes" in by["memory_available"]["missing"]
    # ready timeseries cards carry a stored range
    assert by["cpu_usage"]["query"]["range"] == {"window": 3600, "step": 60}


def test_mimir_uses_mimir_tool():
    rows = cc.build_cards("mimir", {"metrics": ["up"], "labels": []})
    by = {r["card_key"]: r for r in rows}
    assert by["up_targets"]["query"]["tool"] == "mimir_query"


def test_loki_anchor_label_fallback():
    rows = cc.build_cards("loki", {"labels": ["app"]})
    by = {r["card_key"]: r for r in rows}
    assert by["log_volume"]["status"] == "ready"
    assert '{app=~".+"}' in by["log_volume"]["query"]["expr"]
    none = {r["card_key"]: r for r in cc.build_cards("loki", {"labels": ["whatever"]})}
    assert none["log_volume"]["status"] == "unavailable"
    assert set(none["log_volume"]["missing"]) == {"job", "app", "namespace"}


def test_tempo_always_ready():
    rows = cc.build_cards("tempo", {"tags": []})
    assert all(r["status"] == "ready" for r in rows)
    assert {r["card_key"] for r in rows} == {"slow_traces", "error_traces"}


def test_clickhouse_table_resolution_and_identifier_guard():
    good = {"tables": [{"name": "otel_traces", "columns": [{"name": "Timestamp"}, {"name": "TraceId"}, {"name": "ServiceName"}]}]}
    by = {r["card_key"]: r for r in cc.build_cards("clickhouse", good)}
    assert by["otel_span_rate"]["status"] == "ready"
    assert "FROM otel_traces" in by["otel_span_rate"]["query"]["expr"]
    assert by["top_services"]["status"] == "ready"
    # heuristic fallback: Timestamp+TraceId columns, non-otel name
    heur = {"tables": [{"name": "spans_v2", "columns": [{"name": "Timestamp"}, {"name": "TraceId"}]}]}
    by2 = {r["card_key"]: r for r in cc.build_cards("clickhouse", heur)}
    assert "FROM spans_v2" in by2["otel_span_rate"]["query"]["expr"]
    assert by2["top_services"]["status"] == "unavailable"  # no ServiceName column
    # a table name failing the identifier charset is NEVER spliced
    evil = {"tables": [{"name": "otel_traces; DROP TABLE x", "columns": [{"name": "Timestamp"}, {"name": "TraceId"}]}]}
    by3 = {r["card_key"]: r for r in cc.build_cards("clickhouse", evil)}
    assert by3["otel_span_rate"]["status"] == "unavailable"


def test_unknown_kind_and_missing_schema():
    assert cc.build_cards("jaeger", {"tags": []}) == []
    assert cc.build_cards("prometheus", None) == []


def test_purity_no_forbidden_imports():
    import inspect
    src = inspect.getsource(cc)
    for banned in ("boto3", "urllib", "requests", "pg8000", "psycopg"):
        assert banned not in src
```

- [ ] **Step 2: Run to verify fail** — `cd scripts/v2/workers && python3 -m pytest test_card_catalog.py -q` (or the repo's runner) → import error.

- [ ] **Step 3: Implement `diagnosis/card_catalog.py`**

```python
"""Deterministic dashboard-card catalog — the third pre-built-content family
(next to signal_catalog.py / graph_catalog.py). build_cards(kind, schema) is PURE:
no DB, no boto3, no egress. Expressions are module constants; the ONLY schema-derived
splice is the ClickHouse table identifier, validated against _IDENT before use —
a poisoned schema can only make a card `unavailable`, never inject into a query.

CARD_CATALOG_VERSION is mixed into the per-instance card schema hash so editing this
catalog forces a rebuild even when the datasource's schema is unchanged."""
import re

CARD_CATALOG_VERSION = "v1"

_IDENT = re.compile(r"^[A-Za-z0-9_]+$")
_RANGE_1H = {"window": 3600, "step": 60}

_PROM_CARDS = [
    {"card_key": "up_targets", "title": "정상 타깃 수", "viz": "stat", "unit": "",
     "requires": ["up"], "expr": "count(up == 1)", "range": None},
    {"card_key": "cpu_usage", "title": "노드 CPU 사용률", "viz": "timeseries", "unit": "%",
     "requires": ["node_cpu_seconds_total"],
     "expr": '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)', "range": _RANGE_1H},
    {"card_key": "memory_available", "title": "가용 메모리", "viz": "timeseries", "unit": "bytes",
     "requires": ["node_memory_MemAvailable_bytes"],
     "expr": "sum(node_memory_MemAvailable_bytes)", "range": _RANGE_1H},
    {"card_key": "container_cpu", "title": "네임스페이스별 컨테이너 CPU Top5", "viz": "timeseries", "unit": "cores",
     "requires": ["container_cpu_usage_seconds_total"],
     "expr": "topk(5, sum by (namespace) (rate(container_cpu_usage_seconds_total[5m])))", "range": _RANGE_1H},
    {"card_key": "pod_restarts", "title": "최근 1시간 파드 재시작", "viz": "stat", "unit": "",
     "requires": ["kube_pod_container_status_restarts_total"],
     "expr": "sum(increase(kube_pod_container_status_restarts_total[1h]))", "range": None},
]

_LOKI_ANCHORS = ["job", "app", "namespace"]
_LOKI_CARDS = [
    {"card_key": "log_volume", "title": "로그 볼륨 (5m)", "viz": "timeseries", "unit": "lines",
     "expr_tpl": 'sum(count_over_time({{{anchor}=~".+"}}[5m]))'},
    {"card_key": "error_rate", "title": "에러 로그 (5m)", "viz": "timeseries", "unit": "lines",
     "expr_tpl": 'sum(count_over_time({{{anchor}=~".+"}} |~ "(?i)error" [5m]))'},
]

_TEMPO_CARDS = [
    {"card_key": "slow_traces", "title": "느린 트레이스 (>1s)", "viz": "table", "expr": "{ duration > 1s }"},
    {"card_key": "error_traces", "title": "에러 트레이스", "viz": "table", "expr": "{ status = error }"},
]


def _row(card_key, title, viz, unit, status, tool=None, expr=None, rng=None, missing=None):
    return {
        "card_key": card_key, "title": title, "viz": viz, "unit": unit, "status": status,
        "query": ({"tool": tool, "expr": expr, "range": rng} if status == "ready" else None),
        "missing": list(missing or []),
    }


def _prom(kind, schema):
    metrics = {m for m in (schema.get("metrics") or []) if isinstance(m, str)}
    tool = "prometheus_query" if kind == "prometheus" else "mimir_query"
    out = []
    for c in _PROM_CARDS:
        miss = [m for m in c["requires"] if m not in metrics]
        if miss:
            out.append(_row(c["card_key"], c["title"], c["viz"], c["unit"], "unavailable", missing=miss))
        else:
            out.append(_row(c["card_key"], c["title"], c["viz"], c["unit"], "ready", tool, c["expr"], c["range"]))
    return out


def _loki(schema):
    labels = {l for l in (schema.get("labels") or []) if isinstance(l, str)}
    anchor = next((a for a in _LOKI_ANCHORS if a in labels), None)
    out = []
    for c in _LOKI_CARDS:
        if anchor is None:
            out.append(_row(c["card_key"], c["title"], c["viz"], c["unit"], "unavailable", missing=_LOKI_ANCHORS))
        else:
            out.append(_row(c["card_key"], c["title"], c["viz"], c["unit"], "ready",
                            "loki_query_range", c["expr_tpl"].format(anchor=anchor), _RANGE_1H))
    return out


def _tempo():
    return [_row(c["card_key"], c["title"], c["viz"], "", "ready", "tempo_search", c["expr"], None)
            for c in _TEMPO_CARDS]


def _clickhouse(schema):
    tables = [t for t in (schema.get("tables") or []) if isinstance(t, dict)]
    def colnames(t):
        return {c.get("name") for c in (t.get("columns") or []) if isinstance(c, dict)}
    target = next((t for t in tables if t.get("name") == "otel_traces"), None)
    if target is None:
        target = next((t for t in tables if {"Timestamp", "TraceId"} <= colnames(t)), None)
    name = target.get("name") if target else None
    if not (isinstance(name, str) and _IDENT.match(name)):
        missing = ["otel_traces (or a table with Timestamp+TraceId columns)"]
        return [
            _row("otel_span_rate", "최근 1시간 스팬 수", "stat", "spans", "unavailable", missing=missing),
            _row("top_services", "서비스별 스팬 Top5 (1h)", "table", "", "unavailable", missing=missing),
        ]
    out = [_row("otel_span_rate", "최근 1시간 스팬 수", "stat", "spans", "ready", "clickhouse_query",
                f"SELECT count() FROM {name} WHERE Timestamp > now() - INTERVAL 1 HOUR", None)]
    if "ServiceName" in colnames(target):
        out.append(_row("top_services", "서비스별 스팬 Top5 (1h)", "table", "", "ready", "clickhouse_query",
                        f"SELECT ServiceName, count() AS spans FROM {name} "
                        "WHERE Timestamp > now() - INTERVAL 1 HOUR GROUP BY ServiceName ORDER BY spans DESC LIMIT 5", None))
    else:
        out.append(_row("top_services", "서비스별 스팬 Top5 (1h)", "table", "", "unavailable", missing=["ServiceName"]))
    return out


def build_cards(kind, schema):
    """Pure: kind + cached schema dict → card rows. Unknown kind / no schema → []."""
    if not isinstance(schema, dict):
        return []
    if kind in ("prometheus", "mimir"):
        return _prom(kind, schema)
    if kind == "loki":
        return _loki(schema)
    if kind == "tempo":
        return _tempo()
    if kind == "clickhouse":
        return _clickhouse(schema)
    return []
```

(Note the loki `expr_tpl` braces: `{{{anchor}=~".+"}}` renders to `{job=~".+"}` under `.format` —
verify with the test.)

- [ ] **Step 4: Run to verify pass** — all 7 tests green.
- [ ] **Step 5: Commit** — `git add scripts/v2/workers/diagnosis/card_catalog.py scripts/v2/workers/test_card_catalog.py && git commit -m "feat(workers): deterministic dashboard-card catalog"`

---

### Task 3: `db.py` card helpers (TDD)

**Files:**
- Modify: `scripts/v2/workers/db.py` (append next to the graph-queries helpers)
- Test: `scripts/v2/workers/test_db.py` (extend — mirror the existing upsert/sweep tests' fake-conn pattern)

**Interfaces:**
- Produces (used by Task 4):
  - `upsert_dashboard_cards(conn, integration_id, rows, schema_version) -> list[str]` — like `upsert_diag_signals` (sentinel row on empty, returns written keys) but into `datasource_dashboard_cards` with columns `(account_id, integration_id, card_key, title, viz, unit, status, query, missing, schema_version, built_at)`; row dicts carry `card_key/title/viz/unit/status/query/missing`.
  - `read_card_schema_version(conn, integration_id) -> str | None` — clone of `read_signal_schema_version` against the cards table (all-rows-agree contract).
  - `sweep_dashboard_cards(conn, integration_id, keep_keys)` — clone of `sweep_diag_signals`.

- [ ] **Step 1: Write failing tests** (extend `test_db.py` following its existing diag-signal helper tests — same fake connection, assert SQL targets `datasource_dashboard_cards`, sentinel on empty rows, returned keys, sweep excludes keep set).
- [ ] **Step 2: Run** `python3 -m pytest test_db.py -q` → fail (missing attrs).
- [ ] **Step 3: Implement** the three functions, cloning the diag-signal bodies with the cards table/columns; sentinel row uses `SCHEMA_VERSION_SENTINEL_KEY` with `title "(no cards for this schema)"`, `viz "stat"`, `status "unavailable"`, `query None`, `missing []`.
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat(workers): dashboard-card db helpers (upsert/read-version/sweep)"`

---

### Task 4: index-worker wiring + delete-path sweep (TDD)

**Files:**
- Modify: `scripts/v2/workers/datasource_index.py`
- Test: `scripts/v2/workers/test_datasource_index.py` (extend)
- Modify: `web/lib/datasources.ts` (delete path) + `web/lib/datasources.delete.test.ts` (extend)

**Interfaces:**
- Consumes: `card_catalog.build_cards`/`CARD_CATALOG_VERSION` (Task 2), db helpers (Task 3), existing `_canon`/hash helpers and `_rebuild_graph_queries` as the structural template.
- Produces: cards rebuilt inside `run(payload, conn)` for every indexed instance.

- [ ] **Step 1: Write failing tests** (extend `test_datasource_index.py` mirroring its `_rebuild_graph_queries` tests): version-match skip returns `{"cards_skipped": True}`; rebuild calls upsert+sweep in one BEGIN/COMMIT; exception → ROLLBACK + re-raise; result counts `{"cards_built": n, "cards_ready": m}`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement in `datasource_index.py`:**

```python
import card_catalog as _card_cat  # next to graph_catalog import


def _card_schema_version(schema):
    # Same canonical-hash approach as _graph_schema_version, mixed with the card catalog version.
    # No feature flag in the hash — cards have no LLM/generation mode to toggle.
    return _hash_of(_canon(schema), _card_cat.CARD_CATALOG_VERSION)  # reuse the SAME hashing utility
    # ^ IMPORTANT: read _graph_schema_version's actual body first and mirror it exactly
    #   (it may inline hashlib usage rather than a shared helper) — keep byte-level consistency.


def _rebuild_dashboard_cards(conn, wdb, iid, kind, schema):
    version = _card_schema_version(schema)
    if wdb.read_card_schema_version(conn, iid) == version:
        return {"cards_skipped": True}
    rows = _card_cat.build_cards(kind, schema)
    conn.run("BEGIN")
    try:
        written = wdb.upsert_dashboard_cards(conn, iid, rows, version)
        wdb.sweep_dashboard_cards(conn, iid, written)
        conn.run("COMMIT")
    except Exception:
        conn.run("ROLLBACK")
        raise
    return {"cards_built": len(rows), "cards_ready": sum(1 for r in rows if r["status"] == "ready")}
```

Call it in `run()` right after the `_rebuild_graph_queries` call, merging its dict into the result the same way; wrap in the same per-family error isolation `run()` uses (a cards failure must not block signals/graph — read how `run()` guards the other two and mirror).

- [ ] **Step 4: Run worker tests → pass.**
- [ ] **Step 5: Delete-path sweep** — in `web/lib/datasources.ts`, next to the existing `DELETE FROM datasource_diag_signals …` line add:

```ts
  await getPool().query('DELETE FROM datasource_dashboard_cards WHERE integration_id = $1', [id]); // sweep pre-built cards
```

Extend `web/lib/datasources.delete.test.ts`'s mock sequence with one more `.mockResolvedValueOnce({ rows: [] })` per test and assert the new statement (mirror how the diag-signals delete is asserted). Run `npx vitest run lib/datasources.delete.test.ts`.

- [ ] **Step 6: Commit** — `git commit -am "feat(workers): build dashboard cards in the datasource index job; sweep on delete"`

---

### Task 5: BFF read — `web/lib/dashboard-cards.ts` + route (TDD)

**Files:**
- Create: `web/lib/dashboard-cards.ts`, `web/app/api/datasources/[id]/cards/route.ts`
- Test: `web/lib/dashboard-cards.test.ts`

**Interfaces:**
- Produces (used by Task 6):
  - `interface CardQuery { tool: string; expr: string; range: { window: number; step: number } | null }`
  - `interface ReadyCard { cardKey: string; title: string; viz: 'stat' | 'timeseries' | 'table'; unit: string; query: CardQuery }`
  - `interface UnavailableCard { cardKey: string; title: string; missing: string[] }`
  - `getDashboardCards(integrationId: number): Promise<{ ready: ReadyCard[]; unavailable: UnavailableCard[] }>`
  - Route `GET /api/datasources/[id]/cards` → that object (auth + generic 500, exact clone of the diag-signals route).

- [ ] **Step 1: Write failing test** (clone `web/lib/diag-signals.test.ts`'s mock-pool pattern): SQL targets `datasource_dashboard_cards`, excludes `__schema_version__`, splits ready/unavailable, parses string-JSON query/missing.
- [ ] **Step 2: Run → fail.** `npx vitest run lib/dashboard-cards.test.ts`
- [ ] **Step 3: Implement** lib (clone `diag-signals.ts` read minus the querygen gate — no `provenance` filter, cards are deterministic-only) + route (clone `diag-signals/route.ts`, log tag `[dashboard-cards]`).
- [ ] **Step 4: Run → pass; `npx tsc --noEmit -p .` introduces no new errors.**
- [ ] **Step 5: Commit** — `git commit -am "feat(web): dashboard-cards read lib + /api/datasources/[id]/cards"`

---

### Task 6: `CardDashboard` component + detail-page integration (TDD)

**Files:**
- Create: `web/components/datasources/CardDashboard.tsx`
- Test: `web/components/datasources/CardDashboard.test.tsx`
- Modify: `web/app/integrations/datasources/[id]/page.tsx`

**Interfaces:**
- Consumes: `/api/datasources/[id]/cards` (Task 5), `POST /api/datasources/query`, `normalizeResult` from `@/lib/datasource-render`, chart components `AreaTrend`/`MultiLineTrend`, `Card` UI, `useI18n`.
- Produces: `export default function CardDashboard(props: { instanceId: number; onPick?: (expr: string) => void }): JSX.Element | null`

Behavior:
- Fetch cards on mount / instanceId change (clear state first). No rows at all → return `null`.
- Execute ready cards' stored queries via `POST /api/datasources/query` with `{ id: instanceId, query: c.query.expr, ...(c.query.range ? { range: c.query.range } : {}) }`, in sequential batches of 3 (`for` over chunks, `Promise.all` per chunk), storing per-card `{ result?: NormalizedResult; error?: string }` (normalize with `normalizeResult(kind, tool, body)` — the cards fetch response should include the instance `kind`; simplest: have Task 5's lib/route ALSO return `kind` by joining `integrations` the way `diag-signals`' callers resolve it, or accept a `kind` prop passed from the page's existing data. Choose: **return `kind` from the route** (one `getDatasource(id)` call) — the component then needs no extra prop).
- Render grid (`grid gap-3 md:grid-cols-2 xl:grid-cols-3`): each ready card a `Card` with `tt(title)`; body by viz:
  - `stat`: first numeric sample — series shape → last point of first series; table shape → first row's first numeric column; render big (`text-2xl font-semibold`) + unit suffix; non-numeric → error state.
  - `timeseries`: `result.shape === 'series'` → `MultiLineTrend`/`AreaTrend` (mirror ExplorePanel's choice for multi vs single series); else error state.
  - `table`: `DataTable`-lite — first ≤5 rows, existing `DataTable` component if its props allow compact use, else a minimal `<table>`.
  - error → `<span className="text-red-600 text-[12px]">{tt('카드 쿼리 실패:')} {error}</span>` (card stays visible).
- Unavailable cards: dimmed `Card` with `tt('누락:')` + missing list in `title` attr (chips UX).
- Each ready card footer: a small button `tt('Explore에서 열기')` calling `onPick?.(c.query.expr)`.
- Loading: skeleton pulse per pending card.

- [ ] **Step 1: Write failing component test** (mirror `DiagSignalChips.test.tsx` setup — its fetch mocking + render util): (a) renders ready card values after mocked cards+query fetches; (b) unavailable card renders dimmed with missing tooltip; (c) query failure shows per-card error, other cards still render; (d) `onPick` fires with the stored expr; (e) returns null when no rows.
- [ ] **Step 2: Run → fail.** `npx vitest run components/datasources/CardDashboard.test.tsx`
- [ ] **Step 3: Implement the component.**
- [ ] **Step 4: Page integration** — `web/app/integrations/datasources/[id]/page.tsx`: the page is a server component and `ExplorePanel` owns the query box, so wire `onPick` the way the page composes them: convert the page body to render a small client wrapper `DatasourceExploreClient` (new inline client component in the same file is NOT allowed for a server page — put it in `web/components/datasources/` if needed) OR simpler: render `<CardDashboard instanceId={id} />` WITHOUT onPick above `<ExplorePanel …/>` (opening in Explore is a nice-to-have; if ExplorePanel exposes no external setter, drop the onPick affordance and note it in the PR). Decide by reading ExplorePanel's props — do not invent a new coupling mechanism.
- [ ] **Step 5: Full web suite + typecheck + build** — `npm test`, `npx tsc --noEmit -p .` (no NEW errors vs base), `NODE_OPTIONS=--max-old-space-size=8192 npm run build > /tmp/cards-build.log 2>&1` then check exit + grep errors.
- [ ] **Step 6: Commit** — `git commit -am "feat(web): datasource card dashboard (live-executed pre-built cards)"`

---

### Task 7: CHANGELOG + PR

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: CHANGELOG** `[Unreleased] ### Added`, one bullet, BOTH sections (1:1):
- EN: `- Datasource detail pages gain a pre-built card dashboard: registering a datasource (and each daily index run) derives an expected card set from the cached schema — the queries each card uses are stored ahead of time (new datasource_dashboard_cards table + deterministic card_catalog in the index worker) — and the page executes the stored queries live on view through the existing read-only query API (stat/timeseries/table cards, unavailable cards shown dimmed with what's missing).`
- KO: `- 데이터소스 상세 페이지에 사전 생성 카드 대시보드 추가: 등록 시(및 일일 인덱스 배치마다) 캐시된 스키마로부터 예상 카드 세트를 도출하고 각 카드가 사용할 쿼리를 미리 저장(신규 datasource_dashboard_cards 테이블 + 인덱스 워커의 결정론적 card_catalog), 페이지가 저장된 쿼리를 기존 read-only 쿼리 API로 조회 시점에 라이브 실행해 렌더링(stat/시계열/테이블 카드, 미충족 카드는 누락 항목과 함께 비활성 표시).`
- [ ] **Step 2: Full verification** — worker tests + `npm test` + typecheck + build all green.
- [ ] **Step 3: Commit + push + PR**

```bash
git add CHANGELOG.md && git commit -m "feat(datasources): card dashboard CHANGELOG entry"
gh repo set-default Atom-oh/awsops
git push -u origin feat/datasource-dashboard-cards
gh pr create --base main --title "feat(datasources): schema-driven pre-built card dashboard (stored queries, live-executed)" --body "…summary + spec/plan links + test plan…

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
