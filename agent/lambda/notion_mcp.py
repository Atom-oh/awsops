"""
Notion read MCP Lambda — read-only Notion knowledge tools via AgentCore Gateway MCP.
Notion 읽기 전용 MCP Lambda — AgentCore Gateway를 통해 Notion 지식 조회 도구를 제공합니다.

First concrete integration on the M1 gateway-target pattern (ADR-039 read-tier; the
external-obs gateway). READ-ONLY: search / fetch page / query database. No mutation
(consistent with the 2026-06-11 high-risk ADR reversal: AWSops = read-only ops + AI
diagnosis). The Notion integration token is read at runtime from Secrets Manager
(never an env var / TF literal). Not VPC-attached → reaches api.notion.com over the
internet. Stdlib + boto3 only (zip-packaging constraint — no third-party HTTP lib).
"""
import json
import os
import urllib.error
import urllib.request

BASE = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"
DEFAULT_PAGE_SIZE = 10
MAX_PAGE_SIZE = 25  # bound responses well under the 6 MB Lambda limit
HTTP_TIMEOUT = 12   # seconds — chat budget is short; a hung Notion call must not dominate

_TOKEN = None  # warm-container cache (avoid re-fetching the secret each invocation)
_SM = None


# ---- Secrets Manager (seam: tests patch _get_secret_string) ----
def _sm():
    global _SM
    if _SM is None:
        import boto3
        _SM = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    return _SM


def _get_secret_string():
    name = os.environ.get("NOTION_SECRET_NAME", "ops/awsops-v2/integrations/notion")
    return _sm().get_secret_value(SecretId=name).get("SecretString", "")


def _get_token():
    """Return the Notion token, cached per warm container. Raise on a blank/missing secret.

    Secret schema: JSON ``{"token": "secret_x"}`` OR a raw token string.
    """
    global _TOKEN
    if _TOKEN:
        return _TOKEN
    raw = (_get_secret_string() or "").strip()
    if not raw:
        raise ValueError("Notion token not configured (Secrets Manager value is empty)")
    token = raw
    if raw.startswith("{"):
        try:
            token = (json.loads(raw).get("token") or "").strip()
        except (ValueError, AttributeError):
            token = ""
    if not token:
        raise ValueError("Notion token missing from secret (expected {\"token\": ...} or a raw string)")
    _TOKEN = token
    return _TOKEN


# ---- HTTP (seam: tests patch _urlopen) ----
def _urlopen(req, timeout=HTTP_TIMEOUT):
    resp = urllib.request.urlopen(req, timeout=timeout)
    return resp.getcode(), resp.read()


def _http_json(method, path, token, body=None):
    """Call the Notion API. Returns (status, parsed_dict). Non-2xx → (status, error_body)."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Notion-Version", NOTION_VERSION)
    req.add_header("Content-Type", "application/json")
    try:
        status, raw = _urlopen(req)
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            raw = e.read()
        except Exception:
            raw = b""
    try:
        parsed = json.loads(raw or b"{}")
    except ValueError:
        parsed = {}
    return status, parsed


def _clamp_page_size(v):
    try:
        n = int(v)
    except (TypeError, ValueError):
        return DEFAULT_PAGE_SIZE
    return max(1, min(MAX_PAGE_SIZE, n))


def _notion_msg(data, status):
    return data.get("message") or data.get("error") or f"HTTP {status}"


# ---- Tools (read-only) ----
def notion_search(args):
    token = _get_token()
    ps = _clamp_page_size(args.get("page_size"))
    status, data = _http_json("POST", "/search", token,
                              {"query": args.get("query", ""), "page_size": ps})
    if status >= 400:
        return err(f"Notion search failed ({status}): {_notion_msg(data, status)}")
    return ok({"results": data.get("results", []),
               "has_more": data.get("has_more", False),
               "next_cursor": data.get("next_cursor")})


def notion_fetch_page(args):
    page_id = (args.get("page_id") or "").strip()
    if not page_id:
        return err("page_id required")
    token = _get_token()
    status, page = _http_json("GET", f"/pages/{page_id}", token)
    if status >= 400:
        return err(f"Notion fetch_page failed ({status}): {_notion_msg(page, status)}")
    ps = _clamp_page_size(args.get("page_size"))
    cstatus, children = _http_json("GET", f"/blocks/{page_id}/children?page_size={ps}", token)
    if cstatus >= 400:
        # page metadata still useful even if children fail
        return ok({"page": page, "blocks": [], "truncated": False,
                   "blocks_error": f"({cstatus}) {_notion_msg(children, cstatus)}"})
    results = children.get("results", [])
    truncated = bool(children.get("has_more")) or len(results) > MAX_PAGE_SIZE
    return ok({"page": page, "blocks": results[:MAX_PAGE_SIZE], "truncated": truncated})


def notion_query_database(args):
    db = (args.get("database_id") or "").strip()
    if not db:
        return err("database_id required")
    token = _get_token()
    ps = _clamp_page_size(args.get("page_size"))
    status, data = _http_json("POST", f"/databases/{db}/query", token, {"page_size": ps})
    if status >= 400:
        return err(f"Notion query_database failed ({status}): {_notion_msg(data, status)}")
    return ok({"results": data.get("results", []),
               "has_more": data.get("has_more", False),
               "next_cursor": data.get("next_cursor")})


_TOOLS = {
    "notion_search": notion_search,
    "notion_fetch_page": notion_fetch_page,
    "notion_query_database": notion_query_database,
}


def lambda_handler(event, context):
    params = event if isinstance(event, dict) else json.loads(event)
    t = params.get("tool_name", "")
    args = params.get("arguments", params)
    if isinstance(args, dict):
        args.pop("target_account_id", None)  # gateway injects it; Notion is account-agnostic
    fn = _TOOLS.get(t)
    if fn is None:
        return err(f"unknown tool: {t}")
    try:
        return fn(args)
    except ValueError as e:  # missing token / bad args
        return err(str(e))
    except Exception as e:  # noqa: BLE001 — never leak a stack trace to the gateway
        return err(f"notion error: {e}")


def ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str)}


def err(msg):
    return {"statusCode": 400, "body": json.dumps({"error": msg})}
