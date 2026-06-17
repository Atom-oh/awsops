"""AWSops v2 — AI Diagnosis report exporters.

Render an already-generated report markdown into download formats:
  - to_docx(markdown) -> bytes   (python-docx; pure-python)
  - to_pdf(markdown)  -> bytes   (markdown→HTML→headless chromium via playwright)

Read-only: these only transcode a report that was already produced over redacted data. No AWS
mutation, no network egress (the PDF CSS uses the system Noto CJK font — no external @import).
"""
import io
import re

_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_BULLET = re.compile(r"^\s*[-*]\s+(.*)$")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")


def _inline(text: str) -> str:
    """Strip the inline markdown the report uses (links→text, bold/italic/code markers)."""
    text = _LINK.sub(r"\1", text)
    text = text.replace("**", "").replace("`", "")
    return text.strip()


def _is_table_row(line: str) -> bool:
    s = line.strip()
    return s.startswith("|") and s.endswith("|")


def _is_table_separator(line: str) -> bool:
    # |---|:--:| style row — cells are only dashes/colons/spaces
    return bool(re.fullmatch(r"\s*\|[\s|:-]+\|\s*", line))


def _row_cells(line: str):
    return [_inline(c) for c in line.strip().strip("|").split("|")]


def to_docx(markdown: str) -> bytes:
    """Pragmatic markdown→DOCX: headings, the date blockquote, bullets, tables, paragraphs."""
    from docx import Document

    doc = Document()
    lines = markdown.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            i += 1
            continue

        # table block (consecutive | … | rows)
        if _is_table_row(line):
            block = []
            while i < len(lines) and _is_table_row(lines[i]):
                if not _is_table_separator(lines[i]):
                    block.append(_row_cells(lines[i]))
                i += 1
            if block:
                cols = max(len(r) for r in block)
                table = doc.add_table(rows=0, cols=cols)
                table.style = "Light Grid Accent 1"
                for cells in block:
                    row = table.add_row().cells
                    for c in range(cols):
                        row[c].text = cells[c] if c < len(cells) else ""
            continue

        m = _HEADING.match(stripped)
        if m:
            level = min(len(m.group(1)), 4)
            doc.add_heading(_inline(m.group(2)), level=level)
            i += 1
            continue

        b = _BULLET.match(line)
        if b:
            doc.add_paragraph(_inline(b.group(1)), style="List Bullet")
            i += 1
            continue

        if stripped.startswith(">"):  # blockquote (e.g. the generation-date line) → italic
            p = doc.add_paragraph()
            run = p.add_run(_inline(stripped.lstrip("> ").rstrip()))
            run.italic = True
            i += 1
            continue

        doc.add_paragraph(_inline(stripped))
        i += 1

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# A4 print CSS. System font only (Noto Sans CJK KR is installed in the worker image) — NO external
# @import / Google-Fonts URL, since the Fargate worker runs in a private subnet (an external font
# fetch would hang until timeout and Korean would render as tofu anyway).
_PDF_CSS = """
@page { size: A4; margin: 18mm 16mm; }
* { font-family: 'Noto Sans CJK KR', 'Noto Sans', sans-serif; }
body { font-size: 11pt; line-height: 1.55; color: #1a1a1a; }
h1 { font-size: 20pt; } h2 { font-size: 15pt; margin-top: 1.2em; } h3 { font-size: 12.5pt; }
blockquote { color: #555; border-left: 3px solid #ccc; margin: 0 0 1em; padding: .2em .8em; }
table { border-collapse: collapse; width: 100%; margin: .6em 0; }
th, td { border: 1px solid #bbb; padding: 5px 8px; font-size: 10pt; text-align: left; }
code, pre { font-family: monospace; background: #f4f4f4; }
"""


def _html(md_text: str) -> str:
    import markdown as _md

    body = _md.markdown(md_text, extensions=["tables", "fenced_code"])
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<style>{_PDF_CSS}</style></head><body>{body}</body></html>"
    )


def to_pdf(md_text: str) -> bytes:
    """markdown→HTML→headless chromium→PDF bytes. playwright is imported lazily (image-only dep)."""
    from playwright.sync_api import sync_playwright

    html = _html(md_text)
    with sync_playwright() as p:
        # Fargate blocks the user-namespace sandbox chromium uses by default → must disable it.
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-setuid-sandbox"])
        try:
            # Static render of LLM-generated HTML over redacted data → no script execution.
            page = browser.new_page(java_script_enabled=False)
            page.set_content(html, wait_until="load")
            return page.pdf(format="A4", print_background=True)
        finally:
            browser.close()
