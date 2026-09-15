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
ASSIGNMENT_TAIL = re.compile(r"(?P<spacing>\s*)(?P<operator>[:=])(?P<rhs>[^\r\n]*)")
# Inspect complete configuration-key tokens, never substrings of paths or URLs.
CONFIG_KEY = r"[A-Za-z_][A-Za-z0-9_-]*"
KEY_TOKEN = re.compile(r"(?<![\w./:\\-])(" + CONFIG_KEY + r")(?![\w./\\-])")
DEFAULT_SENSITIVE_KEY = (
    r"(?i:(?<![A-Za-z0-9])[A-Za-z0-9_.:-]*(?:password|passwd|pwd|dsn|api[_-]?key|"
    r"secret|token|credential|passphrase|private[_-]?key|cookie|authorization|auth(?![A-Za-z])|dockerconfigjson|"
    r"connection[_-]?string|origin[_-]?verify|AccessKeyId|access[_-]?key[_-]?id|external[_-]?id)[A-Za-z0-9_.:-]*)"
)


def is_assignment(match):
    """Distinguish prose labels from explicit configuration values."""
    if match["operator"] == ":":
        rhs = match["rhs"].strip()
        if re.fullmatch(r"[*_~]*", rhs):
            return False
        # A same-line prose clause after a label is not a configuration example.
        # Quoted/structured values and authorization schemes remain examples,
        # including values containing spaces.
        if (len(rhs.split()) > 1 and rhs[0] not in "\"'[{"
                and not re.match(r"(?i)(?:Bearer|Basic|Digest)\s", rhs)):
            return False
    if (match["operator"] == "=" and any(c in match["spacing"] for c in "\r\n")
            and re.fullmatch(r"=*[ \t]*", match["rhs"])):
        return False
    return True


def format_violation(text, sensitive_pattern=DEFAULT_SENSITIVE_KEY):
    """Return a static failure code; never include external text in diagnostics.

    Only explicit markup and sensitive assignments are classified. Ordinary
    unmarked prose is not parsed as a programming language. Callers supply the
    existing confidentiality policy's sensitive-key regex when they have one;
    legacy shell adapters use the default pattern above.
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
            following = ASSIGNMENT_TAIL.match(text, line_start + closing.end())
            if (re.fullmatch(CONFIG_KEY, reference) and sensitive_pattern.search(reference)
                    and following and is_assignment(following)):
                return ERROR_CODE
            prose.append(body[cursor:opening.start()])
            prose.append("\0")
            cursor = closing.end()
        prose.append(body[cursor:] + "\n")
    if fence is not None:
        return ERROR_CODE
    plain = "".join(prose)
    for token in KEY_TOKEN.finditer(plain):
        if not sensitive_pattern.search(token[1]):
            continue
        tail_start = token.end()
        quote = re.match(r"""\\?["']""", plain[tail_start:tail_start + 2])
        if quote:
            tail_start += quote.end()
        following = ASSIGNMENT_TAIL.match(plain, tail_start)
        if following and is_assignment(following):
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
