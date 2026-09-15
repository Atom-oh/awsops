"""A deliberately small presentation contract, not a Markdown or code parser."""

import re
import argparse
from pathlib import Path
import sys


FORMAT_INSTRUCTIONS = (
    "Use English prose. Inline backticks are only for single-line, whitespace-free "
    "symbol/path references (an empty () suffix is allowed). Put all executable "
    "or configuration examples in closed top-level fenced code blocks, starting "
    "and ending on their own lines at column one. Use a longer outer fence if the example contains "
    "a fence. Do not nest example fences in lists or blockquotes. Use synthetic "
    "values only; never copy credentials. Unsupported examples fail review coverage."
)

ERROR_CODE = "unsupported_review_format"
FENCE = re.compile(r"(`{3,}|~{3,})([^\r\n]*)$")
REFERENCE = re.compile(r"(?:[\w./:$@#*+\[\]\\-]+(?:\(\))?)\Z", re.UNICODE)
TICKS = re.compile(r"`+")
# Legacy shell adapters have no shared Python credential policy. Structured
# adapters pass their existing sensitive-key pattern explicitly instead.
DEFAULT_SENSITIVE_KEY = (
    r"(?i:(?<![A-Za-z0-9])[A-Za-z0-9_.:-]*(?:password|passwd|pwd|dsn|api[_-]?key|"
    r"secret|token|credential|passphrase|private[_-]?key|cookie|authorization|auth(?![A-Za-z])|dockerconfigjson|"
    r"connection[_-]?string|origin[_-]?verify|AccessKeyId|access[_-]?key[_-]?id|external[_-]?id)[A-Za-z0-9_.:-]*)"
)


def format_violation(text, sensitive_pattern=DEFAULT_SENSITIVE_KEY):
    """Return a static failure code; never include external text in diagnostics.

    Only explicit markup and sensitive assignments are classified. Ordinary
    unmarked prose is not parsed as a programming language. Callers supply the
    existing confidentiality policy's sensitive-key regex.
    """
    sensitive_pattern = re.compile(sensitive_pattern)
    fence = None
    prose = []
    offset = 0
    for line in text.splitlines(keepends=True):
        line_start = offset
        offset += len(line)
        body = line.rstrip("\r\n")
        marker = FENCE.fullmatch(body)
        if fence is not None:
            if (marker and marker[1][0] == fence[0]
                    and len(marker[1]) >= len(fence) and not marker[2].strip()):
                fence = None
                prose.append("\0")
            continue
        if marker:
            if not re.fullmatch(r"[A-Za-z0-9_.+-]*[ \t]*", marker[2]):
                return ERROR_CODE
            fence = marker[1]
            prose.append("\0")
            continue
        # Container/indented fences are outside this contract. Delimiter escapes
        # do not opt code examples back into inline syntax.
        if re.search(r"`{3,}|~{3,}", body):
            return ERROR_CODE
        markers = list(TICKS.finditer(body))
        if len(markers) % 2:
            return ERROR_CODE
        cursor = 0
        for opening, closing in zip(markers[::2], markers[1::2]):
            if opening[0] != closing[0]:
                return ERROR_CODE
            reference = body[opening.end():closing.start()]
            if not REFERENCE.fullmatch(reference):
                return ERROR_CODE
            # Formatting only the key does not make an unfenced assignment safe.
            if (sensitive_pattern.search(reference)
                    and re.match(r"\s*[:=]", text[line_start + closing.end():])):
                return ERROR_CODE
            prose.append(body[cursor:opening.start()])
            prose.append("\0")
            cursor = closing.end()
        prose.append(body[cursor:] + "\n")
    if fence is not None:
        return ERROR_CODE
    assignment = re.compile(
        sensitive_pattern.pattern + r"""(?:\\?["'])?\s*[:=]""",
        sensitive_pattern.flags)
    if assignment.search("".join(prose)):
        return ERROR_CODE
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("instructions")
    commands.add_parser("check").add_argument("file", type=Path)
    commands.add_parser("filter")
    args = parser.parse_args()
    if args.command == "instructions":
        print(FORMAT_INSTRUCTIONS)
        return 0
    try:
        text = (sys.stdin.buffer.read().decode("utf-8") if args.command == "filter"
                else args.file.read_text(encoding="utf-8"))
        violation = format_violation(text)
    except (OSError, UnicodeError):
        violation = ERROR_CODE
    if violation:
        print(ERROR_CODE, file=sys.stderr if args.command == "filter" else sys.stdout)
        return 2
    if args.command == "filter":
        # Buffer until validation finishes; rejected source never reaches stdout.
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
