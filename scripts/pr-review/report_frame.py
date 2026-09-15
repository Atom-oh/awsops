#!/usr/bin/env python3
"""Decode one nonce-bound final panel report; terminal chatter is never report content."""
import argparse
import json
from pathlib import Path
import re
import sys
import unicodedata
from review_format import format_violation


ANSI = re.compile(
    r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-9A-Z]"
)
CONTROLS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
NUMBER = r"[0-9]+(?:\.[0-9]+)?"
KIRO_FOOTER = re.compile(rf"▸ (?:Credits: {NUMBER} • )?Time: (?:[0-9]+m )?{NUMBER}s")
FRAME = re.compile(r"REVIEW_COMPLETE: (L[0-9]+) ([0-9a-fA-F]{32}) (.+)")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError("invalid JSON constant")


def decode_report(text, lens, nonce, kiro=False):
    """Validate framing before JSON decoding, preserving every character of report data.

    The nonce binds output to one CI cell/run; it is not an authorization credential.
    ANSI display sequences and an optional Kiro assistant prefix/footer are transport
    decoration. Tool spellings, fences and marker examples inside report never frame it.
    """
    if lens not in ("L2", "L3", "L4", "L5") or not re.fullmatch(r"[0-9a-f]{32}", nonce):
        raise ValueError("missing or invalid expected cell identity")
    lines = []
    # Split physical LF lines only. JSON can legitimately contain Unicode line separators.
    for line in ANSI.sub("", text).split("\n"):
        line = line.strip(" \t\r")
        if kiro and line.startswith("> "):
            line = line[2:].strip(" \t")
        if line:
            lines.append(line)
    if kiro and lines and KIRO_FOOTER.fullmatch(lines[-1]):
        lines.pop()  # At most one numeric footer after the final frame.
    # Only this cell's nonce can identify its envelope. Other-nonce source examples
    # are opaque chatter: never decoded, credited or counted as duplicates. Count
    # every expected-nonce frame regardless of lens so a wrong lens cannot hide.
    frames = [(index, FRAME.fullmatch(line)) for index, line in enumerate(lines)]
    frames = [(index, match) for index, match in frames if match is not None and match[2] == nonce]
    if len(frames) != 1 or frames[0][0] != len(lines) - 1:
        raise ValueError("missing, duplicate or nonfinal completion frame")
    match = frames[0][1]
    if match[1] != lens or match[2] != nonce:
        raise ValueError("completion frame does not match this cell")
    payload = json.loads(match[3], object_pairs_hook=unique_object, parse_constant=reject_constant)
    if not isinstance(payload, dict) or set(payload) != {"report"} or not isinstance(payload["report"], str):
        raise ValueError("completion JSON must contain only a report string")
    report = payload["report"]
    report.encode("utf-8")  # Reject unpaired surrogates before any stdout write.
    visible = CONTROLS.sub("", ANSI.sub("", report))
    if not any(not c.isspace() and unicodedata.category(c)[0] in "LNPS" for c in visible):
        raise ValueError("report has no visible content")
    if format_violation(visible):
        raise ValueError("unsupported_review_format")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("lens")
    parser.add_argument("nonce")
    parser.add_argument("--kiro", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        report = decode_report(args.path.read_text(encoding="utf-8"), args.lens, args.nonce, args.kiro)
    except (OSError, ValueError, UnicodeError, RecursionError):
        print("invalid completed panel report frame", file=sys.stderr)
        return 1
    if not args.check:
        sys.stdout.write(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
