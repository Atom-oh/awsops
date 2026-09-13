"""Specialist assignments; legacy lens IDs remain completion-frame coordinates."""
from pathlib import Path
import sys

ROLES = {
    "codex": ("L2", "correctness", "Trace logic, state transitions, edge cases and regression tests."),
    "kiro-opus": ("L3", "aws", "Review AWS/IAM, authentication, privacy and the accepted mutation gates."),
    "kiro-gpt": ("L4", "operations", "Review deployment, recovery, observability, data freshness and operational contracts."),
}


def prompt(tag, directory):
    lens, role, focus = ROLES[tag]
    base = (Path(directory) / f"{lens}.txt").read_text()
    if tag == "kiro-gpt":
        docs = (Path(directory) / "L5.txt").read_text()
        # Retain the established documentation checklist without a second role assignment.
        if "\nLENS: L5" in docs:
            docs = docs.split("\nLENS: L5", 1)[1].split("\n", 1)[-1]
        base += "\nOperational documentation and contracts:\n" + docs
    return (f"SPECIALIST ROLE: {role}\n{focus}\n"
            "Review the entire supplied diff through this role. Cite concrete evidence and impact.\n"
            "Legacy lens IDs identify completion frames, not additional model calls.\n\n" + base)


if __name__ == "__main__":
    if sys.argv[1:] == ["expected"]:
        print("\n".join(f"{tag}/{row[0]}" for tag, row in ROLES.items()))
    elif len(sys.argv) == 4 and sys.argv[1] == "prompt":
        print(prompt(sys.argv[2], sys.argv[3]))
    else:
        raise SystemExit("usage: specialist_roles.py expected | prompt TAG LENSES_DIR")
