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
