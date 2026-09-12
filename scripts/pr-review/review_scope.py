"""Trusted review control; PR contents are data and never executed."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

MAX_LINES = 3000
CELLS = {f"{model}/L{lens}" for model in ("codex", "kiro-opus", "kiro-gpt") for lens in range(2, 6)}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value), "Invalid commit SHA")
    return value


def select_scope(env, event, api):
    repo, number = env["GITHUB_REPOSITORY"], env["PR_NUMBER"]
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo), "Invalid repository")
    require(re.fullmatch(r"[1-9][0-9]*", number), "Invalid PR number")
    require(env["GITHUB_REF"] == "refs/heads/main", "Review must run from main")
    mode = env["GITHUB_EVENT_NAME"]
    require(mode in ("pull_request_target", "workflow_dispatch"), "Unsupported event")
    pr = api(f"repos/{repo}/pulls/{number}")
    require(pr["number"] == int(number) and pr["base"]["ref"] == "main", "Wrong PR/target")
    require(pr["base"]["repo"]["full_name"] == repo and pr["head"]["repo"]["full_name"] == repo, "Same-repository PR required")
    head = sha(pr["head"]["sha"])
    merge = merge_tree = None
    if mode == "pull_request_target":
        require(pr["state"] == "open" and not pr["merged"], "Open PR required")
        require(event["number"] == int(number) and event["pull_request"]["head"]["sha"] == head, "Stale event HEAD")
        ref = api(f"repos/{repo}/git/ref/heads/main")
        require(ref["ref"] == "refs/heads/main" and ref["object"]["type"] == "commit", "Invalid base ref")
        base = sha(ref["object"]["sha"])  # Never event.pull_request.base.sha.
        comparison = api(f"repos/{repo}/compare/{base}...{head}")
        require(comparison["base_commit"]["sha"] == base, "Compare base mismatch")
        diff_base = sha(comparison["merge_base_commit"]["sha"])
    else:
        require(pr["state"] == "closed" and pr["merged"], "Merged PR required")
        merge = sha(pr["merge_commit_sha"])
        commit = api(f"repos/{repo}/commits/{merge}")
        require(commit["sha"] == merge and len(commit["parents"]) == 2, "Normal two-parent merge required")
        require(commit["parents"][1]["sha"] == head, "Merge second parent must equal PR HEAD")
        head_commit = api(f"repos/{repo}/commits/{head}")
        require(head_commit["sha"] == head, "Head commit mismatch")
        merge_tree = sha(commit["commit"]["tree"]["sha"])
        require(merge_tree == sha(head_commit["commit"]["tree"]["sha"]), "Merged tree differs from PR HEAD; replay refused")
        base = diff_base = sha(commit["parents"][0]["sha"])
    return dict(repo=repo, number=number, mode=mode, base=base, head=head, diff_base=diff_base,
                merge=merge, merge_tree=merge_tree, title=pr["title"])


def verify_scope(saved, env, event, api):
    current = select_scope(env, event, api)
    require(all(saved[key] == current[key] for key in current if key != "title"), "Review scope became stale")


def decision(review, full, panel, responded, *, partial=False, omitted=False, failed=False):
    if partial or len(full.splitlines()) > MAX_LINES or panel != full or omitted:
        return "fail", "Incomplete diff coverage (truncated, changed or omitted content)"
    cells = responded.split()
    if set(cells) != CELLS or len(cells) != len(CELLS):
        return "fail", "Incomplete panel coverage: all 12 cells are required"
    # A nonempty Kiro transcript is not evidence of a completed findings report.
    if re.findall(r"^COVERAGE:.*$", review, re.M) != ["COVERAGE: COMPLETE"]:
        return "fail", "Semantic cell coverage incomplete or unverified by chair"
    if failed or re.findall(r"^VERDICT:.*$", review, re.M) != ["VERDICT: PASS"] or not review.rstrip().endswith("VERDICT: PASS"):
        return "fail", "Chair failed, blocked, or returned an invalid verdict"
    return "pass", "Complete diff, 12 responses and chair-confirmed semantic coverage; no blocking issues"


def api(endpoint):
    require(bool(os.environ.get("GH_TOKEN")), "Authenticated GitHub token required")
    try:
        return json.loads(subprocess.check_output(["gh", "api", endpoint], stderr=subprocess.PIPE))
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        raise ValueError("Authenticated GitHub metadata request failed") from None


def main():
    env = os.environ
    scope_file = Path(env["REVIEW_SCOPE_FILE"])
    event = json.loads(Path(env["GITHUB_EVENT_PATH"]).read_text())
    command = sys.argv[1]
    if command == "select":
        scope = select_scope(env, event, api)
        scope_file.write_text(json.dumps(scope))
        scope_file.chmod(0o600)
        with open(env["GITHUB_OUTPUT"], "a") as output:
            for key in ("base", "head", "diff_base", "number"):
                output.write(f"{key}={scope[key]}\n")
        return
    scope = json.loads(scope_file.read_text())
    full = Path("/tmp/pr-diff.txt").read_bytes()
    digest = hashlib.sha256(full).hexdigest()
    if command == "bind":
        scope.update(diff_sha256=digest, lines=len(full.splitlines()))
        scope_file.write_text(json.dumps(scope))
        return
    require(scope["diff_sha256"] == digest, "Reviewed diff changed")
    read = lambda name: Path(name).read_text() if Path(name).is_file() else ""
    result, reason = decision(
        read("/tmp/review.md"), full, Path("/tmp/pr-diff-truncated.txt").read_bytes(),
        read("/tmp/pr-review/responded.txt"), partial=env.get("panel_truncated") == "1",
        omitted=bool(read("/tmp/pr-diff-omitted.txt") or read("/tmp/pr-diff-omitted-source.txt")),
        failed=env.get("chair_failed") == "1" or Path("/tmp/pr-review/coverage-severe.flag").exists(),
    )
    if command == "gate":
        with open(env["GITHUB_OUTPUT"], "a") as output:
            output.write(f"result={result}\nreason={reason}\n")
    elif command == "verify":
        verify_scope(scope, env, event, api)
        require(env.get("GATE_RESULT") in ("pass", "fail"), "Missing gate decision")
        require(env["GATE_RESULT"] != "pass" or result == "pass", "Review completeness changed")
        print(f"_Review scope: `{scope['mode']}` · base `{scope['base']}` · diff base `{scope['diff_base']}` · head `{scope['head']}`"
              f" · merge `{scope['merge'] or 'n/a'}` · merge/head tree `{scope['merge_tree'] or 'n/a'}`"
              f" · filtered diff SHA-256 `{digest}` · {scope['lines']} lines._")
    else:
        raise ValueError("Unknown review control command")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Review control refused: {error}", file=sys.stderr)
        sys.exit(1)
