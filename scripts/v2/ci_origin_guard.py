#!/usr/bin/env python3
"""Verify the reviewed origin/main snapshot before granting release credentials."""
from __future__ import annotations

import json
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone

REPOSITORY = "Atom-oh/awsops"
REQUIRED_CHECKS = {"AI Code Review", "Merge Verify", "Deck Verify (docs-site pptx gates)"}
CHECK_WORKFLOWS = {
    "AI Code Review": (".github/workflows/pr-review.yml", "pull_request_target"),
    "Merge Verify": (".github/workflows/merge-verify.yml", "pull_request"),
    "Deck Verify (docs-site pptx gates)": (".github/workflows/merge-verify.yml", "pull_request"),
}
SHA = re.compile(r"[0-9a-f]{40}")


class GuardError(RuntimeError):
    pass


def require(value, code):
    if not value:
        raise GuardError(code)


def pages(fetch, endpoint, field=None):
    result = []
    for page in range(1, 11):
        separator = "&" if "?" in endpoint else "?"
        data = fetch(f"{endpoint}{separator}per_page=100&page={page}")
        batch = data.get(field) if field and isinstance(data, dict) else data
        require(isinstance(batch, list), "invalid_api_response")
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise GuardError("review_pagination_incomplete")


def visible_lines(body):
    fence = None
    for raw in body.splitlines():
        line = raw.strip()
        if line.startswith(("```", "~~~")):
            marker = line[:3]
            if fence is None:
                fence = marker
            elif fence == marker:
                fence = None
            continue
        if fence is None and not raw.startswith(("    ", "\t")) and not line.startswith(">"):
            yield line


def configured_cells():
    """Use the same authoritative specialist assignment as the review producer."""
    path = Path(__file__).resolve().parents[1] / "pr-review" / "specialist_roles.py"
    try:
        spec = importlib.util.spec_from_file_location("_origin_review_contract", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        roles = module.ROLES
        require(isinstance(roles, dict) and roles, "review_contract_missing")
        require(all(isinstance(tag, str) and isinstance(row, (tuple, list)) and row
                    and isinstance(row[0], str) and re.fullmatch(r"L[0-9]+", row[0])
                    for tag, row in roles.items()), "review_contract_invalid")
        return {f"{tag}/{row[0]}" for tag, row in roles.items()}
    except (OSError, ImportError, AttributeError, TypeError, SyntaxError):
        raise GuardError("review_contract_unavailable") from None


def blocking_line(line):
    # Handle real GitHub Markdown headings, bullets, numbered lists and emphasis.
    value = re.sub(r"^(?:(?:#{1,6}|[-+*]|\d+[.)])\s+)+", "", line.strip())
    value = value.lstrip("*_ ")
    # Every visible line can introduce a finding, including after context or an
    # earlier Minor finding. Keep severity anchored rather than searching prose.
    value = re.sub(r"^finding\s*#?\s*\d+\b", "", value, flags=re.I)
    value = re.sub(r"^[^\w]+", "", value).lstrip("_")
    # Both **Severity**: Major and **Severity:** Major are common review labels.
    value = re.sub(r"^severity(?: level)?[*_]*\s*:\s*", "", value, flags=re.I)
    value = re.sub(r"^[^\w]+", "", value).lstrip("_")
    return bool(re.match(r"(CRITICAL|MAJOR|P0|P1)\b", value, re.I))


def blocking_comment(body):
    return any(blocking_line(line) for line in visible_lines(body) if line)


def verify_merged_tree(fetch, prefix, commit, head):
    """Match review_scope's normal-merge proof using Git-data API tree fields."""
    merged = fetch(f"{prefix}/git/commits/{commit}")
    reviewed = fetch(f"{prefix}/git/commits/{head}")
    require(isinstance(merged, dict) and merged.get("sha") == commit, "merge_commit_mismatch")
    require(isinstance(reviewed, dict) and reviewed.get("sha") == head, "reviewed_commit_mismatch")
    parents = merged.get("parents")
    require(isinstance(parents, list) and len(parents) == 2
            and all(isinstance(parent, dict) and isinstance(parent.get("sha"), str)
                    and SHA.fullmatch(parent["sha"]) for parent in parents), "normal_two_parent_merge_required")
    require(parents[1]["sha"] == head, "merge_second_parent_mismatch")
    merged_tree, reviewed_tree = merged.get("tree"), reviewed.get("tree")
    require(all(isinstance(tree, dict) and isinstance(tree.get("sha"), str)
                and SHA.fullmatch(tree["sha"]) for tree in (merged_tree, reviewed_tree)),
            "commit_tree_missing_or_invalid")
    require(merged_tree["sha"] == reviewed_tree["sha"], "merge_tree_mismatch")


def verify_ai_comment(comments, head):
    candidates = [
        comment for comment in comments
        if comment.get("user", {}).get("login") == "github-actions[bot]"
        and str(comment.get("body", "")).startswith("<!-- multi-ai-pr-review -->")
    ]
    require(candidates, "required_ai_review_missing")
    comment = max(candidates, key=lambda item: (item.get("updated_at", ""), item.get("id", 0)))
    lines = list(visible_lines(comment["body"]))
    statuses = [re.match(r"^\*\*Status: (PASSED|BLOCKED|ERROR)\*\*", line) for line in lines]
    status = next((match.group(1) for match in statuses if match), None)
    require(status == "PASSED", "required_ai_review_not_passed")
    require(any(line.startswith(f"_Triggered by commit `{head}` · workflow:") for line in lines),
            "required_ai_review_wrong_head")
    require(not any("diff truncated" in line.lower() or "oversized lines" in line.lower() for line in lines),
            "required_ai_review_partial")
    cells = next((re.match(r"^_Cells \(model/lens\):\s*(.*?)\s*_$", line)
                  for line in lines if line.startswith("_Cells (model/lens):")), None)
    require(cells and configured_cells().issubset(set(cells.group(1).split())),
            "required_ai_coverage_incomplete")
    coverage = [line for line in lines if line.startswith("COVERAGE:")]
    require(coverage == ["COVERAGE: COMPLETE"], "semantic_review_coverage_incomplete")
    return comment["id"]


def verify_release(env, fetch):
    require(env.get("GITHUB_REPOSITORY") == REPOSITORY
            and env.get("GITHUB_REF") == "refs/heads/main"
            and env.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and env.get("GITHUB_SERVER_URL") == "https://github.com", "origin_main_dispatch_required")
    commit = env.get("GITHUB_SHA", "")
    require(SHA.fullmatch(commit), "invalid_source_sha")
    prefix = f"repos/{REPOSITORY}"
    before = fetch(f"{prefix}/git/ref/heads/main")
    require(before.get("object", {}).get("sha") == commit, "main_head_moved")
    associated = pages(fetch, f"{prefix}/commits/{commit}/pulls")
    candidates = [
        pr for pr in associated
        if pr.get("merge_commit_sha") == commit and pr.get("state") == "closed" and pr.get("merged_at")
        and pr.get("base", {}).get("ref") == "main"
        and pr.get("base", {}).get("repo", {}).get("full_name") == REPOSITORY
        and pr.get("head", {}).get("repo", {}).get("full_name") == REPOSITORY
    ]
    require(len(candidates) == 1, "reviewed_merge_commit_required")
    pr = fetch(f"{prefix}/pulls/{int(candidates[0]['number'])}")
    require(pr.get("merge_commit_sha") == commit and pr.get("state") == "closed"
            and pr.get("merged_at") and pr.get("base", {}).get("ref") == "main", "pr_scope_changed")
    head = pr.get("head", {}).get("sha", "")
    require(SHA.fullmatch(head), "invalid_reviewed_head")
    verify_merged_tree(fetch, prefix, commit, head)
    number = int(pr["number"])
    checks = pages(fetch, f"{prefix}/commits/{head}/check-runs?filter=latest", "check_runs")
    require(checks, "required_checks_missing")
    for check in checks:
        require(check.get("head_sha") == head and check.get("status") == "completed"
                and check.get("conclusion") in {"success", "neutral", "skipped"}, "checks_not_passed")
    for name in REQUIRED_CHECKS:
        matching = [check for check in checks if check.get("name") == name
                    and check.get("conclusion") == "success"
                    and check.get("app", {}).get("slug") == "github-actions"]
        require(len(matching) == 1,
                "required_check_missing_or_untrusted")
        link = re.fullmatch(r"https://github\.com/Atom-oh/awsops/actions/runs/([0-9]+)/job/[0-9]+",
                            matching[0].get("details_url", ""))
        require(link, "required_check_run_unbound")
        execution = fetch(f"{prefix}/actions/runs/{link.group(1)}")
        path, event = CHECK_WORKFLOWS[name]
        require(execution.get("path") == path and execution.get("event") == event
                and execution.get("head_sha") == head and execution.get("status") == "completed"
                and execution.get("conclusion") == "success", "required_check_workflow_mismatch")
    comment_id = verify_ai_comment(pages(fetch, f"{prefix}/issues/{number}/comments"), head)
    reviews = pages(fetch, f"{prefix}/pulls/{number}/reviews")
    latest = {}
    for review in sorted(reviews, key=lambda item: item.get("id", 0)):
        if review.get("state") in {"APPROVED", "CHANGES_REQUESTED"}:
            latest[review.get("user", {}).get("login")] = review["state"]
    require("CHANGES_REQUESTED" not in latest.values(), "active_change_request")
    inline = pages(fetch, f"{prefix}/pulls/{number}/comments")
    if inline:
        data = fetch(f"review-threads/{number}")
        pull = data.get("data", {}).get("repository", {}).get("pullRequest") or {}
        require(pull.get("headRefOid") == head, "thread_scope_changed")
        threads = pull.get("reviewThreads") or {}
        require(not threads.get("pageInfo", {}).get("hasNextPage"), "thread_coverage_incomplete")
        require(isinstance(threads.get("nodes"), list), "thread_coverage_missing")
        for thread in threads["nodes"]:
            # Outdated only means the diff moved; it is not resolution evidence.
            if thread.get("isResolved") is True:
                continue
            comments = thread.get("comments") or {}
            require(not comments.get("pageInfo", {}).get("hasNextPage"), "thread_coverage_incomplete")
            require(isinstance(comments.get("nodes"), list), "thread_comments_missing")
            require(not any(blocking_comment(item.get("body", "")) for item in comments["nodes"]),
                    "unresolved_blocking_thread")
    after = fetch(f"{prefix}/git/ref/heads/main")
    require(after.get("object", {}).get("sha") == commit, "main_head_moved")
    return {"commit_sha": commit, "reviewed_head": head, "pr_number": number,
            "ai_comment_id": comment_id, "verified_at": datetime.now(timezone.utc).isoformat()}


def github_json(endpoint):
    args = ["gh", "api", "--hostname", "github.com", endpoint]
    if endpoint.startswith("review-threads/"):
        number = endpoint.removeprefix("review-threads/")
        require(number.isdigit(), "invalid_pr_number")
        query = """query($number:Int!) {
          repository(owner:"Atom-oh", name:"awsops") {
            pullRequest(number:$number) {
              headRefOid
              reviewThreads(first:100) { pageInfo { hasNextPage }
                nodes { isResolved isOutdated
                  comments(first:100) { pageInfo { hasNextPage } nodes { body } }
                }
              }
            }
          }
        }"""
        args = ["gh", "api", "--hostname", "github.com", "graphql", "-f", "query=" + query, "-F", "number=" + number]
    try:
        proc = subprocess.run(args, check=True, capture_output=True, text=True, timeout=60)
        return json.loads(proc.stdout)
    except (subprocess.SubprocessError, json.JSONDecodeError):
        raise GuardError("github_verification_unavailable") from None


if __name__ == "__main__":
    try:
        print(json.dumps(verify_release(os.environ, github_json), sort_keys=True))
    except (GuardError, KeyError, TypeError, ValueError) as error:
        code = str(error) if isinstance(error, GuardError) else "invalid_api_response"
        print(json.dumps({"status": "error", "code": code}), file=sys.stderr)
        sys.exit(1)
