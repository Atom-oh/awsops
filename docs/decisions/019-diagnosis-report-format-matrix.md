# ADR-019: Diagnosis Report Format Matrix / 진단 리포트 포맷 매트릭스

## Status: Accepted (2026-04-22) / 상태: 채택됨

## Context / 컨텍스트

The AI Comprehensive Diagnosis feature runs a fixed 15-section Bedrock Opus analysis over the Steampipe inventory, CloudWatch series, and connected datasources, and must deliver the result to several different consumers. Executives and SRE leads want to annotate findings with Word track-changes and comments. Customer-facing consultants present those findings as a slide deck alongside a proposed remediation roadmap. Contract owners archive the deliverable as a tamper-evident PDF for review-board retention. Engineers paste the raw output into Notion, Confluence, or a Jira ticket and expect diffable text. A single "universal" export cannot satisfy all four workflows: paginated documents, slide layouts, print artifacts, and plain text have incompatible structural models. ADR-014 already covers *how* the download URL is delivered (proxy endpoint vs. presigned S3); this ADR covers *which formats* exist and *why each one is worth maintaining*.

AI 종합 진단 기능은 Steampipe 인벤토리, CloudWatch 시계열, 연결된 외부 데이터소스 위에서 고정된 15섹션 Bedrock Opus 분석을 실행하며, 그 결과는 성격이 다른 여러 소비자에게 전달되어야 한다. 임원과 SRE 리드는 Word의 변경 이력/주석 기능으로 결과를 리뷰한다. 고객 대상 컨설턴트는 같은 내용을 슬라이드 덱으로 발표하면서 개선 로드맵을 함께 제시한다. 계약 오너는 리뷰 보드 아카이브용으로 변조 불가능한 PDF 산출물을 요구한다. 엔지니어는 같은 내용을 Notion/Confluence/티켓에 붙여 넣고 diff 가능한 텍스트로 관리한다. 하나의 "범용" 포맷으로는 이 네 워크플로우를 모두 충족할 수 없다 — 문서 페이지네이션, 슬라이드 좌표, 인쇄 산출물, 평문은 구조 모델이 서로 양립하지 않는다. ADR-014는 다운로드 URL *전달 방식*(프록시 vs. presigned S3)을 다루었고, 이 ADR은 *어떤 포맷을 왜 유지하는가*를 정립한다.

## Decision / 결정

AWSops exports every diagnosis report in four formats, each implemented by a dedicated generator that walks the same 15-section list defined in `src/lib/report-prompts.ts`. DOCX is produced by `src/lib/report-docx.ts` via the `docx` npm package (v9.6.1), rendered A4 with a light theme, table of contents, header/footer with page numbers, and a markdown-to-paragraph/table/bullet converter that reuses the parser from `report-pptx.ts`. PPTX is produced by `src/lib/report-pptx.ts` via `pptxgenjs` (v4.0.1) in a WADD (Well-Architected Design Deck) layout: title bars, summary bars, two-column and card layouts, inline tables, and markdown parsing per slide. PDF is produced by `src/lib/report-pdf.ts` via `puppeteer-core` (v24.40.0) driving a headless Chromium that renders the same HTML/CSS shown on screen, then calls `page.pdf({ format: 'A4' })`. Markdown is the raw section output — no transformation beyond the concatenation done by `src/lib/report-generator.ts`. The browser Print-to-PDF path through `src/app/ai-diagnosis/report/page.tsx` is retained as a zero-server-cost fallback and for users who want manual control over paper size or orientation. The `marked` package (v18.0.0) is the shared markdown parser across PDF and the print page.

AWSops는 모든 진단 리포트를 네 포맷으로 내보내며, 각 포맷은 `src/lib/report-prompts.ts`에 정의된 동일한 15섹션 목록을 순회하는 전용 제너레이터로 구현된다. DOCX는 `src/lib/report-docx.ts`가 `docx` 패키지(v9.6.1)로 생성 — A4 라이트 테마, 목차, 페이지 번호가 포함된 헤더/푸터, `report-pptx.ts`와 공유되는 마크다운 → 문단/테이블/블릿 변환기를 사용한다. PPTX는 `src/lib/report-pptx.ts`가 `pptxgenjs`(v4.0.1)로 WADD(Well-Architected Design Deck) 레이아웃으로 생성 — 타이틀 바, 요약 바, 2컬럼/카드 레이아웃, 인라인 테이블, 슬라이드별 마크다운 파싱을 수행한다. PDF는 `src/lib/report-pdf.ts`가 `puppeteer-core`(v24.40.0)로 헤드리스 Chromium을 구동해 화면과 동일한 HTML/CSS를 렌더한 뒤 `page.pdf({ format: 'A4' })`를 호출하여 생성한다. Markdown은 `src/lib/report-generator.ts`가 섹션을 이어 붙인 원본 그대로이며 별도 변환이 없다. `src/app/ai-diagnosis/report/page.tsx`를 통한 브라우저 Print-to-PDF 경로는 서버 비용 0의 폴백으로 유지되며 사용자가 용지 크기/방향을 직접 제어할 필요가 있을 때 사용된다. `marked` 패키지(v18.0.0)는 PDF와 인쇄 페이지가 공유하는 마크다운 파서다.

Format matrix / 포맷 매트릭스:

```text
Format    Library              Primary consumer          Why this format
--------  -------------------  ------------------------  ---------------------------------
DOCX      docx v9.6.1          Execs, SRE leads          Word track-changes / comments review
PPTX      pptxgenjs v4.0.1     Customer-facing decks     WADD-style slide deliverable
PDF       puppeteer-core       Contract / audit archive  Tamper-evident, matches on-screen
          v24.40.0                                       rendering via shared HTML/CSS
Markdown  (no converter)       Engineers, tickets        Diff-friendly; Notion / Confluence
                                                         / Jira paste-in
Print     marked v18.0.0       Ad-hoc PDF, fallback      Zero server cost; user-controlled
                                                         paper size / orientation
```

## Rationale / 근거

- **Four formats, not one universal format**: Each target audience has a workflow the others cannot reuse. Executives will not review a PPTX deck in Word; consultants cannot present a Markdown file from a meeting screen; auditors will not accept a DOCX as a signed archive; engineers will not paste a PDF into a Jira ticket. Collapsing any pair into one format degrades at least one workflow and shifts the formatting burden onto the consumer.

각기 다른 소비자(임원/SRE 리드, 컨설턴트, 감사자, 엔지니어)의 워크플로우는 서로 대체 불가능하다. 두 포맷을 하나로 합치면 최소 하나의 워크플로우가 저하되며, 포맷 변환 부담이 소비자에게 전가된다.

- **Puppeteer-based PDF over a pure-library PDF generator**: The dashboard already renders a print-friendly page at `src/app/ai-diagnosis/report/page.tsx`. Puppeteer drives that HTML/CSS pipeline verbatim via `page.setContent()` followed by `page.pdf({ format: 'A4' })`, so the archived PDF matches exactly what users see on screen. `pdfkit` or `react-pdf` would force a parallel rendering pipeline that would drift from the print page over time and double the maintenance cost for every theme change.

대시보드는 이미 인쇄용 페이지를 렌더링한다. Puppeteer는 동일한 HTML/CSS 파이프라인을 그대로 재사용하여 "화면에서 본 것 = 아카이브된 것" 동기화를 유지한다. `pdfkit`/`react-pdf` 류는 별도 렌더 파이프라인을 강제하므로 테마 변경 시 유지 비용이 두 배가 된다.

- **Keep the browser Print-to-PDF path alongside the server PDF**: Headless Chromium can crash on font or emoji inputs, and Puppeteer adds memory overhead on every run. The browser path has zero server cost, gives the user paper-size and orientation controls, and acts as a recovery route when the server pipeline fails due to host memory pressure or Chromium version skew.

헤드리스 Chromium은 폰트/이모지 입력에서 비정상 종료할 수 있고 Puppeteer는 실행마다 메모리 오버헤드를 발생시킨다. 브라우저 Print 경로는 서버 비용이 0이고, 용지/방향을 사용자가 제어할 수 있으며, 서버 파이프라인 장애 시 복구 경로로 동작한다.

- **`pptxgenjs` for PPTX rather than converting from DOCX**: Slides are not paginated documents. The WADD two-column and card layouts are expressed in slide coordinates (inches/points from slide origin), not in Word paragraph flow. Auto-conversion from DOCX produces text-only slides with no layout hierarchy — unreadable for customer presentations, and unusable as a sales deliverable.

슬라이드는 페이지네이션된 문서가 아니다. WADD 2컬럼/카드 레이아웃은 슬라이드 좌표(인치/포인트)로 표현되며 Word 문단 플로우와 양립하지 않는다. DOCX 자동 변환은 계층 없는 텍스트 덤프를 낳아 고객 발표용으로 부적합하다.

- **`docx` package with a manual markdown-to-paragraph mapper**: Gives explicit control over heading levels, bullet indents, table shading, and page breaks, and keeps the A4 light theme consistent across sections. A generic markdown-to-DOCX converter would introduce its own quirks (inconsistent heading styles, unstyled tables) and would be harder to align with the PPTX generator's shared parser.

`docx` 패키지와 수동 마크다운 매퍼는 제목 레벨, 블릿 들여쓰기, 테이블 셰이딩, 페이지 브레이크를 명시적으로 제어하며 A4 라이트 테마를 섹션 전반에 일관되게 유지한다. 범용 마크다운 → DOCX 변환기는 고유 quirks를 들여오고 PPTX 제너레이터의 공유 파서와 정렬하기가 더 어렵다.

- **15 sections are prompt-fixed in `report-prompts.ts`**: All four generators walk the same ordered section list, so the Table of Contents and slide order are deterministic. Changing the section count is a coordinated change across `report-prompts.ts`, `report-generator.ts`, and the four generators — by design, to prevent format drift and to make the deliverable contract explicit.

15섹션은 `report-prompts.ts`에 프롬프트 단위로 고정되어 있다. 네 제너레이터 모두 동일한 순서 목록을 순회하므로 TOC/슬라이드 순서가 결정적이다. 섹션 수 변경은 다섯 파일(`report-prompts.ts`, `report-generator.ts`, 네 제너레이터)을 동시에 건드려야 하며, 이는 포맷 드리프트를 차단하고 산출물 계약을 명시화하기 위한 의도된 제약이다.

- **Puppeteer is resident on the EC2 host only**: `puppeteer-core` uses the Playwright-installed Chromium under `~/.cache/ms-playwright/` on the EC2 instance. It is never bundled into the Next.js client, so the browser payload is unaffected by the PDF pipeline.

`puppeteer-core`는 EC2 인스턴스의 `~/.cache/ms-playwright/` 아래 Playwright가 설치한 Chromium을 실행한다. Next.js 클라이언트 번들에는 포함되지 않으므로 브라우저 다운로드 용량은 PDF 파이프라인의 영향을 받지 않는다.

## Consequences / 결과

### Positive / 긍정적

- Each consumer receives a format that fits their workflow natively — no format is a compromise for another audience.
- The PDF pipeline reuses the on-screen print page, so "what you see on screen" and "what is archived" stay in lockstep without a second template.
- The browser Print-to-PDF fallback costs zero server resources and keeps the feature usable when headless Chromium fails (font issues, memory pressure, Chromium version skew).
- Markdown output makes report diffs trivial in pull requests, tickets, and Notion/Confluence pages.
- All four generators share the same 15-section contract, so regressions in one format surface immediately (TOC mismatch, missing section) rather than drifting silently.

각 소비자는 자신의 워크플로우에 맞는 포맷을 그대로 받고, PDF는 화면 렌더링과 동기화되며, 브라우저 Print 폴백은 서버 비용 없이 가용성을 보강하고, Markdown은 PR/티켓에서 diff가 쉽고, 네 제너레이터의 15섹션 계약이 포맷 간 드리프트를 조기에 드러낸다.

### Negative / Trade-offs / 부정적 / 트레이드오프

- Four generators to maintain. Adding a new diagnosis section requires editing `report-prompts.ts`, `report-generator.ts`, and each of the four generators (section icon map, color map, layout rules).
- DOCX and PPTX libraries have limited markdown coverage. Extending section content to new element types (nested tables, mermaid diagrams, embedded charts) requires per-generator implementation work, not a one-line change.
- Puppeteer is heavy: it ships a Chromium binary (~150 MB on ARM64), consumes 200-400 MB of RSS per report render, and can crash on unexpected font or emoji inputs. The browser Print path exists partly because of this risk.
- The Next.js API layer sits on the critical path for server-side PDF. When the EC2 host is under memory pressure, PDF generation fails first — the DOCX/PPTX/Markdown paths still work, and users can fall back to the browser print route.
- Format parity is enforced manually. There is no test that asserts "every section in `report-prompts.ts` renders a heading in every generator"; drift between generators is currently caught only by visual review.

네 제너레이터 유지 비용, DOCX/PPTX의 제한된 마크다운 지원, Puppeteer의 메모리/바이너리 부담, 서버사이드 PDF의 장애점, 그리고 포맷 간 패리티를 보장하는 자동화된 테스트 부재를 트레이드오프로 수용한다.

## References / 참고 자료

### Internal
- [ADR-009](009-alert-triggered-ai-diagnosis.md): Alert-Triggered AI Diagnosis — the alert pipeline also produces reports and must honor the same four-format contract.
- [ADR-014](014-report-proxy-download-urls.md): Report Delivery via Proxy URLs — covers *how* each of these four artifacts is delivered to the browser (this ADR covers *which formats exist*).
- `src/lib/report-prompts.ts`: 15-section prompt definitions — the shared contract every generator walks.
- `src/lib/report-generator.ts`: Diagnosis data collection orchestrator (Steampipe + CloudWatch + datasources).
- `src/lib/report-docx.ts`: DOCX generator (A4, TOC, markdown → paragraphs/tables/bullets).
- `src/lib/report-pptx.ts`: PPTX generator (WADD-style slide deck).
- `src/lib/report-pdf.ts`: Server-side PDF generator (Puppeteer + headless Chromium).
- `src/app/ai-diagnosis/report/page.tsx`: Print-friendly HTML page (browser Print-to-PDF fallback).
- [CLAUDE.md](../../CLAUDE.md): Root project context (15-section contract, report bucket, library pinning).

### External
- [docx npm package](https://www.npmjs.com/package/docx) — DOCX generation.
- [pptxgenjs](https://gitbrent.github.io/PptxGenJS/) — PPTX generation library.
- [Puppeteer page.pdf()](https://pptr.dev/api/puppeteer.page.pdf) — headless Chromium PDF export.
- [marked](https://marked.js.org/) — Markdown parser shared by PDF and print page.
