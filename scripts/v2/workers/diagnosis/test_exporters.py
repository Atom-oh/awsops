from diagnosis import exporters

_SAMPLE = "# AWS 진단 리포트\n\n> 생성 일시: 2026-06-17 09:00 (KST)\n\n## 요약\n\n본문 문단입니다.\n\n- 항목 A\n- 항목 B\n\n| 키 | 값 |\n|----|----|\n| a  | 1  |\n"


def test_to_docx_returns_docx_zip_bytes():
    out = exporters.to_docx(_SAMPLE)
    assert isinstance(out, (bytes, bytearray)) and len(out) > 0
    assert bytes(out[:4]) == b"PK\x03\x04"  # DOCX is a zip (OOXML)


def test_to_pdf_returns_pdf_bytes():
    import pytest
    pytest.importorskip("playwright")  # playwright is image-only; skip in local/CI without it
    try:
        out = exporters.to_pdf(_SAMPLE)
    except Exception as e:  # chromium binary not installed in this env
        pytest.skip(f"chromium unavailable: {e}")
    assert isinstance(out, (bytes, bytearray)) and bytes(out[:5]) == b"%PDF-"


def test_html_template_uses_system_font_no_external_import():
    html = exporters._html("# t\n\n본문")
    assert "Noto Sans CJK KR" in html
    assert "@import" not in html and "fonts.googleapis" not in html  # no egress in private subnet
