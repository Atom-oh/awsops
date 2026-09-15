"""Trusted review control; PR contents are data and never executed."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from review_format import format_violation

MAX_LINES = 3000
CELLS = {f"{model}/L{lens}" for model in ("codex", "kiro-opus", "kiro-gpt") for lens in range(2, 6)}


def expected_cells(env=None):
    env = os.environ if env is None else env
    if env.get("ROLE_REVIEW") == "1":
        from specialist_roles import ROLES
        return {f"{tag}/{role[0]}" for tag, role in ROLES.items()}
    return CELLS


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
                merge=merge, merge_tree=merge_tree, title=pr["title"],
                required_cells=sorted(expected_cells(env)))


def verify_scope(saved, env, event, api):
    current = select_scope(env, event, api)
    require(all(saved[key] == current[key] for key in current if key != "title"), "Review scope became stale")


def failure_context(saved, env, api):
    """Report failure without overwriting a newer HEAD's canonical verdict."""
    require(saved["repo"] == env["GITHUB_REPOSITORY"] and saved["number"] == env["PR_NUMBER"], "Wrong saved review identity")
    head = sha(saved["head"])
    current = api(f"repos/{saved['repo']}/pulls/{saved['number']}")
    require(current["number"] == int(saved["number"]) and current["base"]["ref"] == "main", "Wrong current PR")
    require(current["base"]["repo"]["full_name"] == saved["repo"] and current["head"]["repo"]["full_name"] == saved["repo"], "Wrong current repository")
    return sha(current["head"]["sha"]) == head


def decision(review, full, panel, responded, *, partial=False, omitted=False, failed=False):
    if partial or len(full.splitlines()) > MAX_LINES or panel != full or omitted:
        return "fail", "Incomplete diff coverage (truncated, changed or omitted content)"
    cells = responded.split()
    expected = expected_cells()
    if set(cells) != expected or len(cells) != len(expected):
        return "fail", f"Incomplete panel coverage: all {len(expected)} configured reports are required"
    if failed:
        return "fail", "Review phases did not complete successfully"
    if format_violation(review):
        return "fail", "Review format contract failed; code examples require fenced blocks"
    # A nonempty Kiro transcript is not evidence of a completed findings report.
    if re.findall(r"^COVERAGE:.*$", review, re.M) != ["COVERAGE: COMPLETE"]:
        return "fail", "Semantic cell coverage incomplete or unverified by chair"
    if re.findall(r"^VERDICT:.*$", review, re.M) != ["VERDICT: PASS"] or not review.rstrip().endswith("VERDICT: PASS"):
        return "fail", "Chair blocked or returned an invalid verdict"
    return "pass", "Complete diff and all configured reports with chair-confirmed coverage; no blocking issues"


def full_reports_snapshot(work):
    """Validate the chair's retained streams, not their semantic completeness."""
    work = work.resolve()
    manifest = work / "full-reports.json"
    require(not manifest.is_symlink() and manifest.is_file(), "Missing full reports manifest")
    require(not work.stat().st_mode & 0o077 and not manifest.stat().st_mode & 0o277,
            "Full reports manifest must be protected and read-only")
    raw = manifest.read_bytes()
    records = json.loads(raw)["reports"]
    expected = expected_cells()
    require(isinstance(records, list) and len(records) == len(expected), "All configured full reports required")
    require({record["cell"] for record in records} == expected, "Full report cell mismatch")
    prompt_path, stdin_path = work / "synth-prompt.txt", work / "synth-stdin.txt"
    require(prompt_path.is_file() and not prompt_path.is_symlink(), "Missing trusted chair prompt")
    require(stdin_path.is_file() and not stdin_path.is_symlink(), "Missing bound chair input")
    prompt = prompt_path.read_bytes()
    prompt_lines = prompt.decode("utf-8").splitlines()
    directories = [line[len("TRUSTED_FULL_REPORT_DIR: "):] for line in prompt_lines
                   if line.startswith("TRUSTED_FULL_REPORT_DIR: ")]
    authorities = [line[len("TRUSTED_FULL_REPORTS_JSON: "):] for line in prompt_lines
                   if line.startswith("TRUSTED_FULL_REPORTS_JSON: ")]
    require(len(directories) == 1 and len(authorities) == 1
            and authorities[0].encode("utf-8") == raw, "Unbound full report read authority")
    allowed_directory = Path(directories[0])
    stdin = stdin_path.read_bytes()
    for record in records:
        path = Path(record["path"])
        require(path.is_absolute() and path.parent == allowed_directory and path.parent.parent == work
                and path.parent.name.startswith("full-reports.")
                and path.name == record["cell"].replace("/", "-") + ".md"
                and not path.parent.is_symlink() and not path.is_symlink(),
                "Invalid full report path")
        require(stat.S_ISREG(path.stat().st_mode) and not path.stat().st_mode & 0o277
                and not path.parent.stat().st_mode & 0o077, "Full report must be protected and read-only")
        data = path.read_bytes()
        require(type(record["size"]) is int and record["size"] > 0
                and len(data) == record["size"]
                and hashlib.sha256(data).hexdigest() == record["sha256"], "Full report changed")
        marker = ("FULL_REPORT: " + json.dumps(record) + "\n").encode()
        require(marker in stdin, "Full report was not exposed to the chair")
    return dict(manifest_sha256=hashlib.sha256(raw).hexdigest(),
                stdin_sha256=hashlib.sha256(stdin).hexdigest(),
                prompt_sha256=hashlib.sha256(prompt).hexdigest())


def api(endpoint):
    require(bool(os.environ.get("GH_TOKEN")), "Authenticated GitHub token required")
    try:
        return json.loads(subprocess.check_output(["gh", "api", endpoint], stderr=subprocess.PIPE))
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        raise ValueError("Authenticated GitHub metadata request failed") from None


def main():
    command = sys.argv[1]
    if command == "max-lines":
        print(MAX_LINES)
        return
    env = os.environ
    scope_file = Path(env["REVIEW_SCOPE_FILE"])
    event = json.loads(Path(env["GITHUB_EVENT_PATH"]).read_text())
    if command == "select":
        scope = select_scope(env, event, api)
        scope_file.write_text(json.dumps(scope))
        scope_file.chmod(0o600)
        with open(env["GITHUB_OUTPUT"], "a") as output:
            for key in ("base", "head", "diff_base", "number"):
                output.write(f"{key}={scope[key]}\n")
        return
    scope = json.loads(scope_file.read_text())
    if command == "failure-context":
        canonical = failure_context(scope, env, api)
        with open(env["GITHUB_OUTPUT"], "a") as output:
            output.write(f"canonical={'true' if canonical else 'false'}\n")
        print(f"_Review verification failed for head `{sha(scope['head'])}`; scope or integrity changed. Re-run required._")
        return
    full = Path("/tmp/pr-diff.txt").read_bytes()
    digest = hashlib.sha256(full).hexdigest()
    if command == "bind":
        scope.update(diff_sha256=digest, lines=len(full.splitlines()))
        scope_file.write_text(json.dumps(scope))
        return
    require(scope["diff_sha256"] == digest, "Reviewed diff changed")
    require(scope["required_cells"] == sorted(expected_cells(env)), "Required review roles changed")
    phases_succeeded = (
        env.get("REVIEW_PHASES_SUCCEEDED") == "true"
        if command == "gate" else scope.get("review_phases_succeeded") is True
    )
    read = lambda name: Path(name).read_text() if Path(name).is_file() else ""
    result, reason = decision(
        read("/tmp/review.md"), full, Path("/tmp/pr-diff-truncated.txt").read_bytes(),
        read("/tmp/pr-review/responded.txt"), partial=env.get("panel_truncated") == "1",
        omitted=bool(read("/tmp/pr-diff-omitted.txt") or read("/tmp/pr-diff-omitted-source.txt")),
        failed=not phases_succeeded or env.get("chair_failed") == "1"
        or Path("/tmp/pr-review/coverage-severe.flag").exists(),
    )
    reports = None
    try:
        reports = full_reports_snapshot(Path("/tmp/pr-review"))
    except (OSError, ValueError, KeyError, TypeError):
        if result == "pass":
            result, reason = "fail", "Full panel reports missing, changed or unbound"
    if command == "gate":
        scope["review_phases_succeeded"] = phases_succeeded
        scope["full_reports"] = reports
        scope_file.write_text(json.dumps(scope))
        with open(env["GITHUB_OUTPUT"], "a") as output:
            output.write(f"result={result}\nreason={reason}\n")
    elif command == "verify":
        verify_scope(scope, env, event, api)
        require(env.get("GATE_RESULT") in ("pass", "fail"), "Missing gate decision")
        require(env["GATE_RESULT"] != "pass" or result == "pass", "Review completeness changed")
        require(env["GATE_RESULT"] != "pass" or reports == scope.get("full_reports"),
                "Full reports or chair input changed since gate")
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
