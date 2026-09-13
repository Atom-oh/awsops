#!/usr/bin/env python3
"""Separate Codex JSONL tool data from reports and native error diagnostics.

Only completed agent messages reach the existing nonce-frame validator. Tool
payloads are never interpreted as diagnostics, even when they contain JSON or
model/account error examples. Failed or incomplete streams emit no report.
"""
import json
import sys


def main():
    started = completed = failed = False
    messages = []
    try:
        for line in sys.stdin:
            try:
                event = json.loads(line)
            except ValueError:
                failed = True
                continue
            if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                failed = True
                continue
            kind = event["type"]
            if completed:
                failed = True
            if kind in ("error", "turn.failed"):
                failed = True
                error = event.get("error", event)
                text = error.get("message") if isinstance(error, dict) else None
                if isinstance(text, str):
                    # One native event is one physical diagnostic line. Do not
                    # let its formatting open a fence in the stderr classifier.
                    print(" ".join(text.splitlines()), file=sys.stderr)
                continue
            if kind == "turn.started":
                if started:
                    failed = True
                started = True
            elif kind == "turn.completed":
                if not started:
                    failed = True
                completed = True
            elif kind == "item.completed":
                item = event.get("item")
                if not started or not isinstance(item, dict):
                    failed = True
                elif item.get("type") == "agent_message":
                    text = item.get("text")
                    if not isinstance(text, str):
                        failed = True
                    else:
                        # Keep every message: an early/duplicate completion
                        # envelope must remain visible to report_frame.py.
                        messages.append(text if text.endswith("\n") else text + "\n")
        if failed or not completed or not messages:
            print("Codex event stream did not complete with agent output", file=sys.stderr)
            return 1
        output = "".join(messages)
        output.encode("utf-8")  # Reject unpaired surrogates before writing.
        sys.stdout.write(output)
        return 0
    except (OSError, UnicodeError):
        print("Codex event stream could not be decoded", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
