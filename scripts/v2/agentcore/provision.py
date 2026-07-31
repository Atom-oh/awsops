#!/usr/bin/env python3
"""AWSops v2 P1f — idempotent AgentCore provisioner.

Reads `terraform -chdir=terraform/v2/foundation output -json` -> ensures Runtime,
9 Gateways, the slice Targets, Memory, Code Interpreter exist (list->create/update),
writes ARNs to SSM, prints a diff/no-op report.

  python3 scripts/v2/agentcore/provision.py          # provision (idempotent)
  python3 scripts/v2/agentcore/provision.py --smoke   # provision + invoke runtime via 1 gateway

Run from the repo root (so `terraform -chdir=...` resolves) AFTER `terraform apply`.
"""
import argparse
import copy
import ipaddress
import json
import os
import subprocess
import sys
import time
from urllib.parse import urlparse

import boto3
from botocore.exceptions import ClientError

import catalog  # same directory

TFDIR = "terraform/v2/foundation"
RUNTIME_NAME = "awsops_v2_agent"                 # underscores only
MEMORY_NAME = "awsops_v2_memory"                 # underscores only
INTERPRETER_NAME = "awsops_v2_code_interpreter"  # underscores only
IMAGE_TAG = os.environ.get("AGENT_IMAGE_TAG", "agent-latest")  # keep in sync with agentcore.mjs push tag

report = []  # (resource, status, detail)


def log(resource, status, detail=""):
    report.append((resource, status, detail))
    print(f"  [{status:8}] {resource}  {detail}")


def tf_outputs():
    raw = subprocess.check_output(["terraform", f"-chdir={TFDIR}", "output", "-json"], text=True)
    data = json.loads(raw)
    if "agentcore" not in data or data["agentcore"]["value"] is None:
        sys.exit("agentcore output is null — set agentcore_enabled=true and `terraform apply` first.")
    return data["agentcore"]["value"]


def _items(resp):
    """AgentCore list APIs are inconsistent on the wrapper key."""
    for k in ("items", "memories", "gateways", "agentRuntimes", "codeInterpreters", "codeInterpreterSummaries"):
        if k in resp:
            return resp[k]
    return []


def _list_all(list_fn, **kwargs):
    """Paginate an AgentCore list_* call (nextToken) and return ALL items."""
    out, token = [], None
    while True:
        resp = list_fn(**{**kwargs, "nextToken": token}) if token else list_fn(**kwargs)
        out.extend(_items(resp))
        token = resp.get("nextToken")
        if not token:
            return out


def gateway_url(gw_id, region):
    return f"https://{gw_id}.gateway.bedrock-agentcore.{region}.amazonaws.com/mcp"


def ensure_gateways(ctrl, ac):
    """9 gateways, idempotent by exact name. Returns {short_key: gateway_id}."""
    existing = {g.get("name"): g.get("gatewayId") for g in _list_all(ctrl.list_gateways)}
    ids = {}
    for key in catalog.GATEWAYS:
        name = f"awsops-v2-{key}-gateway"  # v2-namespaced: isolate from v1 awsops-* in shared accounts
        if name in existing:
            ids[key] = existing[name]
            log(f"gateway:{key}", "EXISTS", name)
            continue
        try:
            resp = ctrl.create_gateway(
                name=name,
                roleArn=ac["role_arn"],
                protocolType="MCP",
                authorizerType="NONE",
                description=catalog.GATEWAY_DESCRIPTIONS.get(key, key),
            )
            ids[key] = resp["gatewayId"]
            log(f"gateway:{key}", "CREATED", name)
        except ClientError as e:
            log(f"gateway:{key}", "ERR", str(e)[:140])
    return ids


def _inject_account(tools):
    """Deep-copy so we never mutate the shared catalog.TARGETS dicts, then add the
    cross-account target_account_id property to each tool's inputSchema."""
    out = []
    for t in tools:
        t = copy.deepcopy(t)
        t.setdefault("inputSchema", {}).setdefault("properties", {}).setdefault("target_account_id", {
            "type": "string",
            "description": "Target AWS account ID for cross-account access (12 digits). Only provide when instructed.",
        })
        out.append(t)
    return out


def ensure_targets(ctrl, ac, gw_ids, skip_names=frozenset()):
    """Slice targets, idempotent by name. update_gateway_target on tool-schema drift.

    skip_names: legacy TARGETS names that ensure_mcp_server_targets owns THIS run (the preset is
    active or actively cutting over). Without this, ensure_targets (which only looks at whether
    the lambda_arn is still in the tf output — true for the whole ADR-017 deprecation window) would
    recreate a legacy target that a PRIOR run's ensure_mcp_server_targets retired, and THIS run's
    ensure_mcp_server_targets would retire it again seconds later — flapping the target into
    existence and back out every single provisioner run (kiro review MAJOR finding, 2026-07-31),
    which is exactly the duplicate-tool-name window the retire ordering is meant to prevent."""
    for tname, spec in catalog.TARGETS.items():
        if tname in skip_names:
            log(f"target:{tname}", "SKIP", "superseded by an active ADR-017 mcp-server preset — owned by ensure_mcp_server_targets this run")
            continue
        gw_id = gw_ids.get(spec["gateway"])
        if not gw_id:
            log(f"target:{tname}", "ERR", f"gateway {spec['gateway']} missing")
            continue
        lambda_arn = ac["lambda_arns"].get(spec["lambda_key"])
        if not lambda_arn:
            # Flag-gated targets (e.g. notion-mcp when integrations_enabled=false) have no Lambda
            # in the tf output. That is expected, not an error — SKIP so `make agentcore` exits 0.
            log(f"target:{tname}", "SKIP", f"lambda {spec['lambda_key']} not in tf output (flag off?)")
            continue
        tools = _inject_account(spec["tools"])
        cfg = {"mcp": {"lambda": {"lambdaArn": lambda_arn, "toolSchema": {"inlinePayload": tools}}}}
        creds = [{"credentialProviderType": "GATEWAY_IAM_ROLE"}]
        existing = {t.get("name"): t for t in _list_all(ctrl.list_gateway_targets, gatewayIdentifier=gw_id)}
        try:
            if tname in existing:
                tid = existing[tname]["targetId"]
                cur = ctrl.get_gateway_target(gatewayIdentifier=gw_id, targetId=tid)
                cur_tools = cur.get("targetConfiguration", {}).get("mcp", {}).get("lambda", {}).get("toolSchema", {}).get("inlinePayload", [])
                # Drift = tool-NAME set only; intra-tool schema edits (description/inputSchema/required)
                # are NOT detected. Adding/removing a tool re-syncs; editing one in place needs a rename.
                if {t["name"] for t in cur_tools} == {t["name"] for t in tools}:
                    log(f"target:{tname}", "EXISTS", f"{len(tools)} tools")
                else:
                    ctrl.update_gateway_target(gatewayIdentifier=gw_id, targetId=tid, name=tname,
                                                description=spec["description"], targetConfiguration=cfg,
                                                credentialProviderConfigurations=creds)
                    log(f"target:{tname}", "UPDATED", f"{len(tools)} tools (schema drift)")
            else:
                ctrl.create_gateway_target(gatewayIdentifier=gw_id, name=tname, description=spec["description"],
                                            targetConfiguration=cfg, credentialProviderConfigurations=creds)
                log(f"target:{tname}", "CREATED", f"{len(tools)} tools")
        except ClientError as e:
            log(f"target:{tname}", "ERR", str(e)[:140])


def _endpoint_blocked(endpoint):
    """ADR-017 defense-in-depth (kiro review MAJOR finding, 2026-07-31): official_mcp_endpoints is
    an https-only tfvars map (enforced by ai.tf's variable validation block at plan time), but a
    tfvars edit can be applied without ever re-running that validation against code that already
    changed — this is the second, runtime check. Mirrors the ALWAYS-BLOCKED subset of
    web/lib/ssrf-guard.ts isAlwaysBlockedHost (metadata/loopback/link-local/multicast/unspecified) —
    RFC1918 private is deliberately ALLOWED (several ADR-017 presets are explicitly self-hosted
    in-VPC per catalog.py's own comments, e.g. ClickHouse/Grafana/Splunk). Returns a reason string
    if blocked, else None. A non-literal hostname (the common case) is not resolved here — same
    deferral to connect time as the TS guard."""
    try:
        parsed = urlparse(endpoint)
    except ValueError:
        return "unparsable URL"
    if parsed.scheme != "https":
        return f"scheme {parsed.scheme!r} is not https"
    host = (parsed.hostname or "").lower()
    if not host:
        return "no host in URL"
    if host == "localhost" or host.endswith(".localhost"):
        return "loopback hostname"
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return None  # non-literal hostname
    if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or str(ip) == "255.255.255.255":
        return f"IP {ip} is loopback/link-local/multicast/unspecified (always blocked)"
    return None


def _load_official_mcp_secret(ac):
    """ADR-017: preset credentials live in the SAME shared secret the web BFF writes connector
    credentials into (web/lib/integration-credentials.ts), under the NAMESPACED key
    "mcp:<preset_key>" — e.g. {"mcp:datadog": {"token": "..."}}. The plain (non-namespaced)
    preset_key is a SEPARATE map entry owned by the datasource-connector kind-mirror
    (mirrorDefaultCredential) for the 5 presets that are ALSO a DATASOURCE_KINDS member
    (clickhouse/tempo/jaeger/dynatrace/datadog) — reusing that key for the MCP credential clobbers
    the connector's {endpoint, authType, ...} shape and vice versa (kiro review MAJOR finding,
    2026-07-31). setMcpPresetCredential (web/lib/integration-credentials.ts) writes the same
    "mcp:<preset_key>" key.

    Returns (secret_map, read_ok). read_ok=False means the READ OR PARSE ITSELF failed (a
    transient Secrets Manager error, e.g. throttling, or malformed JSON) — the caller must NOT
    treat that the same as "the credential is genuinely absent" (which retires any live target),
    or a transient API blip on a routine `make agentcore` re-run would mass-deprovision every
    configured preset (kiro review finding, 2026-07-31). read_ok=True with an empty/missing key
    means integrations_enabled=false or the credential genuinely isn't stored — both real SKIP
    states, not errors."""
    secret_name = ac.get("integrations_secret_name")
    if not secret_name:
        return {}, True  # integrations_enabled=false is a real "nothing configured" state
    sm = boto3.client("secretsmanager", region_name=ac["region"])
    try:
        resp = sm.get_secret_value(SecretId=secret_name)
    except ClientError as e:
        log("mcp-server:secret", "ERR", str(e)[:140])
        return {}, False
    try:
        m = json.loads(resp.get("SecretString") or "{}")
    except json.JSONDecodeError as e:
        log("mcp-server:secret", "ERR", f"malformed JSON: {e}"[:140])
        return {}, False
    return (m if isinstance(m, dict) else {}), True


def _ensure_api_key_provider(ctrl, provider_name, token):
    """Idempotent AgentCore Identity API-key credential provider: create if missing, update if the
    token changed. get_api_key_credential_provider does NOT return the key value back (write-only
    vault semantics) so drift can't be detected here — update_api_key_credential_provider is called
    every run when a token is present; AgentCore Identity itself is expected to no-op on an
    unchanged value. Returns the providerArn, or "" on failure."""
    try:
        existing = ctrl.get_api_key_credential_provider(name=provider_name)
        arn = existing["credentialProviderArn"]
        ctrl.update_api_key_credential_provider(name=provider_name, apiKey=token)
        return arn
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") not in ("ResourceNotFoundException",):
            log(f"mcp-server-provider:{provider_name}", "ERR", str(e)[:140])
            return ""
    try:
        resp = ctrl.create_api_key_credential_provider(name=provider_name, apiKey=token)
        return resp["credentialProviderArn"]
    except ClientError as e:
        log(f"mcp-server-provider:{provider_name}", "ERR", str(e)[:140])
        return ""


def _api_key_provider_fields(credential_provider_configurations):
    """Extract (providerArn, location, param_name, prefix) an API_KEY credentialProviderConfigurations
    entry uses, or None for any other/absent config. providerArn is included (not just the header
    wiring) so a provider that got deleted-and-recreated (new ARN, same location/param/prefix) is
    still detected as drift — otherwise the target keeps pointing at a now-nonexistent provider."""
    cfgs = credential_provider_configurations or []
    if not cfgs or cfgs[0].get("credentialProviderType") != "API_KEY":
        return None
    apk = (cfgs[0].get("credentialProvider") or {}).get("apiKeyCredentialProvider") or {}
    return (apk.get("providerArn"), apk.get("credentialLocation"), apk.get("credentialParameterName"), apk.get("credentialPrefix", ""))


def _delete_api_key_provider(ctrl, provider_name):
    """Best-effort delete — a missing provider is not an error (nothing to retire)."""
    try:
        ctrl.delete_api_key_credential_provider(name=provider_name)
        log(f"mcp-server-provider:{provider_name}", "DELETED", "retired")
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") != "ResourceNotFoundException":
            log(f"mcp-server-provider:{provider_name}", "ERR", str(e)[:140])


# Gateway target lifecycle states (GetGatewayTarget `status`), confirmed against the botocore
# model: CREATING/UPDATING/SYNCHRONIZING are in-flight; READY is the only "safe to cut over to"
# state; the rest are terminal failures.
_TARGET_TERMINAL_FAILURE_STATUSES = {"FAILED", "UPDATE_UNSUCCESSFUL", "SYNCHRONIZE_UNSUCCESSFUL"}


def _wait_target_ready(ctrl, gw_id, target_id, tname, timeout_s=30, interval_s=2):
    """Poll GetGatewayTarget until status=READY (True), a terminal failure status (False, logged),
    or timeout_s elapses (False, logged). create/update_gateway_target return as soon as the
    request is ACCEPTED, not once the target is actually usable — retiring the legacy target right
    after that 200, without confirming READY, can cut over to a target that isn't live yet (kiro
    review finding, 2026-07-31)."""
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            status = ctrl.get_gateway_target(gatewayIdentifier=gw_id, targetId=target_id).get("status")
        except ClientError as e:
            log(f"target:{tname}:ready", "ERR", str(e)[:140])
            return False
        if status == "READY":
            return True
        if status in _TARGET_TERMINAL_FAILURE_STATUSES:
            log(f"target:{tname}:ready", "ERR", f"reached terminal status {status}, never became READY")
            return False
        if time.monotonic() >= deadline:
            log(f"target:{tname}:ready", "ERR", f"timed out after {timeout_s}s waiting for READY (last status: {status})")
            return False
        time.sleep(interval_s)


def _retire_gateway_target(ctrl, gw_id, existing, tname, reason):
    """Delete a live gateway target by name, if it exists. Used both to retire a disabled/removed
    ADR-017 preset's target and to clear a legacy lambda target out of the way before cutover."""
    t = existing.get(tname)
    if not t:
        return
    try:
        ctrl.delete_gateway_target(gatewayIdentifier=gw_id, targetId=t["targetId"])
        log(f"target:{tname}", "RETIRED", reason)
        existing.pop(tname, None)  # keep the cache correct for the rest of this run
    except ClientError as e:
        log(f"target:{tname}", "ERR", str(e)[:140])


def ensure_mcp_server_targets(ctrl, ac, gw_ids, secrets=None, secrets_read_ok=None):
    """ADR-017: register curated official-vendor MCP servers as remote `mcpServer` gateway targets.

    Ordering is deliberate and safety-critical (2026-07-31 kiro review, findings #1/#2 on the first
    cut of this function):
      1. INACTIVE (no endpoint, or api_key mode with no stored credential) -> retire only THIS
         preset's own mcp-server target + credential provider if a prior run left them live. The
         legacy lambda target is NEVER touched here — an incomplete/reverted cutover must leave the
         old tool working, not take it down too. This covers both "flag/endpoint off" AND
         "credential removed while the endpoint stays configured" (finding #2 — a missing
         credential is not merely a no-op skip, it must also tear down a now-uncredentialed target).
      2. ACTIVE -> validate the credential provider FIRST, then create/update the new target, and
         ONLY on confirmed success (CREATED/UPDATED/EXISTS) retire the legacy lambda target. Doing
         the legacy delete BEFORE the new target was confirmed live was the outage bug (finding #1):
         a missing credential or a create/update failure would delete the working old tool with
         nothing to replace it.

    secrets/secrets_read_ok: pass the values from a caller-side _load_official_mcp_secret(ac) call
    to avoid a second Secrets Manager read when main() already needed one (to compute the
    ensure_targets legacy-skip set); when omitted (e.g. every existing test), loads them itself.
    """
    endpoints = ac.get("official_mcp_endpoints") or {}
    lambda_arns = ac.get("lambda_arns") or {}
    read_only_acks = ac.get("official_mcp_read_only_ack") or {}
    if secrets is None:
        secrets, secrets_read_ok = _load_official_mcp_secret(ac)
    existing_by_gw = {}  # gateway short-key -> {target_name: target}, fetched once per gateway

    def gw_existing(gw_key):
        gw_id = gw_ids.get(gw_key)
        if not gw_id:
            return None, {}
        if gw_key not in existing_by_gw:
            existing_by_gw[gw_key] = {t.get("name"): t for t in _list_all(ctrl.list_gateway_targets, gatewayIdentifier=gw_id)}
        return gw_id, existing_by_gw[gw_key]

    for tname, spec in catalog.MCP_SERVER_TARGETS.items():
        preset_key = spec["preset_key"]
        endpoint = endpoints.get(preset_key)
        gw_id, existing = gw_existing(spec["gateway"])
        if not gw_id:
            log(f"target:{tname}", "ERR", f"gateway {spec['gateway']} missing")
            continue

        auth = spec["auth"]
        provider_name = f"awsops-v2-{preset_key}-mcp"

        if endpoint:
            blocked_reason = _endpoint_blocked(endpoint)
            if blocked_reason:
                log(f"target:{tname}", "ERR", f"official_mcp_endpoints['{preset_key}'] rejected: {blocked_reason}")
                _retire_gateway_target(ctrl, gw_id, existing, tname, "endpoint failed the SSRF/scheme guard — retiring")
                _delete_api_key_provider(ctrl, provider_name)
                continue

        token = None
        if auth["mode"] == "api_key":
            raw = secrets.get(f"mcp:{preset_key}")
            token = raw.get("token") if isinstance(raw, dict) else None

        if auth["mode"] == "api_key" and not token and not secrets_read_ok:
            # Could not READ the credentials secret this run (transient Secrets Manager error /
            # malformed JSON) — this is NOT the same as "the credential was intentionally removed"
            # and must never retire a live target on that basis (kiro review finding, 2026-07-31:
            # a transient API blip would otherwise mass-deprovision every configured preset). Fail
            # safe: skip this preset, touch nothing.
            log(f"target:{tname}", "SKIP", f"could not read credentials secret this run for preset '{preset_key}' — leaving any existing target/provider untouched")
            continue

        if endpoint and read_only_acks.get(preset_key) != endpoint:
            # CRITICAL (kiro review, 2026-07-31): unlike the Lambda TARGETS (toolSchema.inlinePayload
            # hard-limits the exposed tool set), an mcpServer target has NO server-side tool
            # allowlist — it exposes 100% of whatever the vendor's remote MCP server advertises,
            # write tools included. ADR-017's read_only_note (spec["read_only_note"]) is currently
            # "trust the vendor's own config" (RBAC scope / --disable-write / etc); provision.py has
            # no control-plane API to introspect the vendor's live tool list (tools/list only exists
            # on the data-plane MCP endpoint, not bedrock-agentcore-control) so it cannot verify that
            # claim itself. Fail CLOSED: require an explicit per-preset operator acknowledgment
            # (terraform var.official_mcp_read_only_ack[preset_key] = the exact endpoint reviewed)
            # that the read_only_note control was actually verified on the vendor side, before
            # provisioning at all — default {} means nothing provisions until acked.
            #
            # ack is bound to the ENDPOINT VALUE, not just the preset_key (round-3 review MAJOR,
            # 2026-07-31 fix): comparing != endpoint (not just falsy) means changing
            # official_mcp_endpoints[preset_key] to a different URL without a matching re-ack is
            # treated exactly like never having acked at all — fail-closed, retire, no silent
            # credential handoff to an unreviewed endpoint.
            log(f"target:{tname}", "SKIP",
                f"official_mcp_read_only_ack['{preset_key}'] missing or doesn't match the current "
                f"endpoint — refusing to provision an unenforced write surface "
                f"({spec.get('read_only_note', 'no read-only note')}); ack in terraform.tfvars "
                "(value = the exact endpoint URL) only after verifying the vendor-side read-only "
                "control, and re-ack whenever the endpoint changes")
            _retire_gateway_target(ctrl, gw_id, existing, tname, "read-only ack missing or stale (endpoint changed since ack) — retiring")
            _delete_api_key_provider(ctrl, provider_name)
            continue

        if not endpoint or (auth["mode"] == "api_key" and not token):
            reason = "no endpoint configured" if not endpoint else "no stored credential"
            log(f"target:{tname}", "SKIP", f"{reason} for preset '{preset_key}' (official_mcp_enabled/endpoint or Connectors tab)")
            _retire_gateway_target(ctrl, gw_id, existing, tname, f"{reason} — retiring")
            # Best-effort: AWS may reject deleting a provider while a target still references it
            # if the just-issued target deletion is still async. A failure here is logged (ERR) and
            # self-heals on the NEXT provisioner run — this SKIP path re-attempts the delete every
            # time the preset stays inactive, and delete_api_key_credential_provider is idempotent.
            _delete_api_key_provider(ctrl, provider_name)
            continue

        # INFORMATIONAL only (dead-code reminder) — does NOT gate target creation. The legacy
        # target itself (below, AFTER a confirmed-successful create/update) is what closes the
        # actual duplicate-tool-name risk; a tf-config-only check can't see a leftover target
        # object from a prior run, and gating on it would just reproduce that gap.
        conflict = catalog.conflicting_lambda_key(preset_key, lambda_arns)
        if conflict:
            log(f"target:{tname}", "WARN", f"lambda '{conflict}' still deployed — remove from ai.tf local.agent_lambdas (dead code once this preset is live)")

        creds = [{"credentialProviderType": "GATEWAY_IAM_ROLE"}]
        if auth["mode"] == "api_key":
            provider_arn = _ensure_api_key_provider(ctrl, provider_name, token)
            if not provider_arn:
                continue  # error already logged by _ensure_api_key_provider — legacy target untouched
            api_key_provider = {
                "providerArn": provider_arn,
                "credentialLocation": auth["credential_location"],
                "credentialParameterName": auth["credential_parameter_name"],
            }
            # ponytail: defensive only — omit credentialPrefix entirely when the preset has none
            # (e.g. New Relic's "Api-Key" header takes no prefix) rather than passing "", in case
            # botocore/the API enforces a min-length on this field (unverified as of 2026-07-31
            # review; AWS testing would confirm either way — this fix is safe regardless).
            if auth.get("credential_prefix"):
                api_key_provider["credentialPrefix"] = auth["credential_prefix"]
            creds = [{
                "credentialProviderType": "API_KEY",
                "credentialProvider": {"apiKeyCredentialProvider": api_key_provider},
            }]

        cfg = {"mcp": {"mcpServer": {"endpoint": endpoint, "listingMode": "DEFAULT"}}}
        tid_final = None
        tid_to_sync = None
        try:
            if tname in existing:
                tid_final = existing[tname]["targetId"]
                cur = ctrl.get_gateway_target(gatewayIdentifier=gw_id, targetId=tid_final)
                cur_endpoint = cur.get("targetConfiguration", {}).get("mcp", {}).get("mcpServer", {}).get("endpoint")
                cur_provider = _api_key_provider_fields(cur.get("credentialProviderConfigurations"))
                new_provider = _api_key_provider_fields(creds)
                drifted = (cur_endpoint != endpoint or cur_provider != new_provider or cur.get("description") != spec["description"])
                if not drifted:
                    log(f"target:{tname}", "EXISTS", endpoint)
                    # Round-3 review MAJOR (2026-07-31): ADR-017's whole stated benefit is "the
                    # vendor maintains the tool list, we don't" — but a sync request only fired on
                    # CREATE/UPDATE, never on an unchanged EXISTS target, so a vendor adding/renaming
                    # tools on their end never reached this Gateway after the first provision. Sync
                    # every run regardless of drift; synchronize_gateway_targets is a cheap best-effort
                    # refresh request, not a mutation of our config.
                    tid_to_sync = tid_final
                else:
                    ctrl.update_gateway_target(gatewayIdentifier=gw_id, targetId=tid_final, name=tname,
                                                description=spec["description"], targetConfiguration=cfg,
                                                credentialProviderConfigurations=creds)
                    log(f"target:{tname}", "UPDATED", f"drift: endpoint/description/credential-provider config changed -> {endpoint}")
                    tid_to_sync = tid_final
            else:
                resp = ctrl.create_gateway_target(gatewayIdentifier=gw_id, name=tname, description=spec["description"],
                                                   targetConfiguration=cfg, credentialProviderConfigurations=creds)
                log(f"target:{tname}", "CREATED", endpoint)
                tid_final = resp["targetId"]
                tid_to_sync = tid_final
        except ClientError as e:
            log(f"target:{tname}", "ERR", str(e)[:140])
            continue  # new target failed — leave the legacy lambda target alone (no outage)

        if tid_to_sync:
            # Best-effort refresh request — its success/failure is INDEPENDENT of whether the
            # target actually reaches READY (checked below), so a sync failure alone must not
            # short-circuit the ready-wait or silently permit an unconfirmed cutover either way.
            try:
                ctrl.synchronize_gateway_targets(gatewayIdentifier=gw_id, targetIdList=[tid_to_sync])
                log(f"target:{tname}:sync", "OK", "tools/list refresh requested")
            except ClientError as e:
                log(f"target:{tname}:sync", "ERR", str(e)[:140])

        # create/update_gateway_target return as soon as the request is ACCEPTED, not once the
        # target is actually usable — confirm READY before treating the new target as the live
        # replacement (kiro review finding, 2026-07-31). Not ready -> leave the legacy lambda
        # target alone; retry on the next provisioner run (this whole block is idempotent).
        if not _wait_target_ready(ctrl, gw_id, tid_final, tname):
            continue

        legacy_name = catalog.legacy_target_name(preset_key)
        if legacy_name:
            # The legacy lambda target may live on a DIFFERENT gateway than this preset's new
            # mcpServer target (e.g. tempo-mcp-target is on 'monitoring' while
            # tempo-mcp-server-target is on 'external-obs') — searching only `existing` (this
            # preset's own gateway) can never find it there, so it would live forever (kiro review
            # MAJOR finding, 2026-07-31). Look up the legacy target's OWN gateway from the catalog.
            legacy_gw_key = (catalog.TARGETS.get(legacy_name) or {}).get("gateway", spec["gateway"])
            legacy_gw_id, legacy_existing = gw_existing(legacy_gw_key)
            if legacy_gw_id and legacy_name in legacy_existing:
                _retire_gateway_target(ctrl, legacy_gw_id, legacy_existing, legacy_name,
                                        f"superseded by {tname} (ADR-017 cutover, confirmed READY)")


def _cutover_preset_keys(ac, secrets, secrets_read_ok):
    """Preset keys ensure_mcp_server_targets will treat as ACTIVE this run — same conditions as its
    own SKIP/retire branch (endpoint configured, ack'd, and — for api_key auth — a credential
    present OR the secret read itself failed, mirroring that function's own fail-safe so this
    helper and ensure_mcp_server_targets never disagree). Used by main() to tell ensure_targets
    which legacy lambda targets are owned by ensure_mcp_server_targets this run (see
    ensure_targets' skip_names docstring for why that matters — otherwise the legacy target flaps)."""
    endpoints = ac.get("official_mcp_endpoints") or {}
    read_only_acks = ac.get("official_mcp_read_only_ack") or {}
    active = set()
    for spec in catalog.MCP_SERVER_TARGETS.values():
        preset_key = spec["preset_key"]
        endpoint = endpoints.get(preset_key)
        if not endpoint or read_only_acks.get(preset_key) != endpoint:
            continue
        if spec["auth"]["mode"] == "api_key":
            raw = secrets.get(f"mcp:{preset_key}")
            token = raw.get("token") if isinstance(raw, dict) else None
            if not token and secrets_read_ok:
                continue
        active.add(preset_key)
    return active


def prune_moved_targets(ctrl, gw_ids):
    """Idempotent reconcile: delete a target that the catalog has MOVED to a different gateway —
    a KNOWN target name still living on a gateway it is no longer assigned to. Prevents the
    split-brain after a catalog gateway reassignment (e.g. prometheus/clickhouse → external-obs),
    where ensure_targets creates the target on its new home but the stale copy lingers on the old
    gateway (exposing a tool the old gateway's prompt no longer documents). Runs AFTER ensure_targets
    so the new target exists before the old one is removed. Targets whose name is NOT in the catalog
    are manual/experimental — never auto-deleted, only logged."""
    desired = {tname: spec["gateway"] for tname, spec in catalog.TARGETS.items()}
    desired.update({tname: spec["gateway"] for tname, spec in catalog.MCP_SERVER_TARGETS.items()})
    # Snapshot every provisioned gateway's targets once.
    by_gw = {gw_key: _list_all(ctrl.list_gateway_targets, gatewayIdentifier=gw_id)
             for gw_key, gw_id in gw_ids.items()}
    # SAFETY (review #86 M1): a name is safe to prune off an OLD gateway ONLY if it is confirmed
    # live on its DESIRED home gateway. If the new home target wasn't created — flag-OFF (lambda
    # SKIPped) or a create that ERRed (e.g. GW-not-READY ValidationException) — we must NOT delete
    # the last copy, or the tool vanishes from every gateway. Preserve the old copy until the move
    # actually lands (next idempotent run completes it).
    safe = {name for name, home in desired.items()
            if any(t.get("name") == name for t in by_gw.get(home, []))}
    for gw_key, gw_id in gw_ids.items():
        for t in by_gw[gw_key]:
            name = t.get("name")
            home = desired.get(name)
            if home is None:
                log(f"prune:{name}", "KEEP", f"not in catalog (manual?) on {gw_key}")
            elif home != gw_key:
                if name not in safe:
                    log(f"prune:{name}", "KEEP", f"home {home} has no live target yet — keeping {gw_key} copy")
                    continue
                try:
                    ctrl.delete_gateway_target(gatewayIdentifier=gw_id, targetId=t["targetId"])
                    log(f"prune:{name}", "DELETED", f"orphan on {gw_key} (moved → {home})")
                except ClientError as e:
                    log(f"prune:{name}", "ERR", str(e)[:140])


def ensure_memory(ctrl):
    # ListMemories items carry id/arn/status but NOT name; resolve name via get_memory.
    for m in _list_all(ctrl.list_memories):
        mid = m.get("id") or m.get("memoryId")
        if not mid:
            continue
        try:
            detail = ctrl.get_memory(memoryId=mid).get("memory", {})
        except ClientError:
            detail = {}
        if detail.get("name") == MEMORY_NAME:
            log("memory", "EXISTS", mid)
            return mid
    try:
        resp = ctrl.create_memory(name=MEMORY_NAME, description="AWSops v2 conversation history",
                                  eventExpiryDuration=365)
        # CreateMemory returns {"memory": {"id": ...}}.
        mem = resp.get("memory", resp)
        mid = mem.get("id") or mem.get("memoryId")
        log("memory", "CREATED", mid)
        return mid
    except ClientError as e:
        log("memory", "ERR", str(e)[:140])
        return ""


def ensure_interpreter(ctrl):
    for c in _list_all(ctrl.list_code_interpreters):
        if c.get("name") == INTERPRETER_NAME:
            cid = c.get("codeInterpreterId") or c.get("id")
            log("interpreter", "EXISTS", cid)
            return cid
    try:
        resp = ctrl.create_code_interpreter(name=INTERPRETER_NAME,
                                            networkConfiguration={"networkMode": "PUBLIC"})
        cid = resp.get("codeInterpreterId") or resp.get("id")
        log("interpreter", "CREATED", cid)
        return cid
    except ClientError as e:
        log("interpreter", "ERR", str(e)[:140])
        return ""


def ensure_runtime(ctrl, ac, gw_ids):
    region = ac["region"]
    gateways_json = json.dumps({k: gateway_url(v, region) for k, v in gw_ids.items()})
    artifact = {"containerConfiguration": {"containerUri": f"{ac['ecr_uri']}:{IMAGE_TAG}"}}
    # VPC mode when the TF output supplies subnets+SGs (Pattern 2: ENIs in our VPC so agents reach
    # private Aurora/EKS; egress to Bedrock/AgentCore still works via the subnets' NAT). Falls back
    # to PUBLIC otherwise. networkMode/networkModeConfig flip in-place (no interruption).
    subnets = ac.get("subnets") or []
    sgs = ac.get("security_groups") or []
    if subnets and sgs:
        netcfg = {"networkMode": "VPC",
                  "networkModeConfig": {"subnets": subnets, "securityGroups": sgs}}
    else:
        netcfg = {"networkMode": "PUBLIC"}
    # AWSOPS_HOST_ACCOUNT_ID lets agent.account_utils skip the per-cold-start STS
    # GetCallerIdentity lookup (same value cross_account.py uses on the tool
    # Lambdas). Account parsed from the role ARN (arn:aws:iam::<account>:role/...).
    env = {"AWS_REGION": region, "GATEWAYS_JSON": gateways_json,
           "AWSOPS_HOST_ACCOUNT_ID": ac["role_arn"].split(":")[4],
           # Dark-path chat loop (ADR-008 amended / BASELINE §2) — default OFF. Set explicitly on the
           # runtime so it survives re-provisioning and is toggleable via the normal deploy path:
           # `ANTHROPIC_AGENT_LOOP_ENABLED=true make agentcore`.
           "ANTHROPIC_AGENT_LOOP_ENABLED": os.environ.get("ANTHROPIC_AGENT_LOOP_ENABLED", "false")}
    existing = {r.get("agentRuntimeName"): r for r in _list_all(ctrl.list_agent_runtimes)}
    try:
        if RUNTIME_NAME in existing:
            rid = existing[RUNTIME_NAME].get("agentRuntimeId")
            # v1 quirk: update MUST re-pass roleArn + networkConfiguration.
            resp = ctrl.update_agent_runtime(agentRuntimeId=rid, roleArn=ac["role_arn"],
                                             agentRuntimeArtifact=artifact, networkConfiguration=netcfg,
                                             environmentVariables=env)
            arn = resp.get("agentRuntimeArn") or existing[RUNTIME_NAME].get("agentRuntimeArn")
            log("runtime", "UPDATED", arn)
            return arn
        resp = ctrl.create_agent_runtime(agentRuntimeName=RUNTIME_NAME, roleArn=ac["role_arn"],
                                         agentRuntimeArtifact=artifact, networkConfiguration=netcfg,
                                         environmentVariables=env)
        arn = resp.get("agentRuntimeArn")
        log("runtime", "CREATED", arn)
        return arn
    except ClientError as e:
        log("runtime", "ERR", str(e)[:160])
        return ""


def write_ssm(ac, runtime_arn, interpreter_id, memory_id):
    ssm = boto3.client("ssm", region_name=ac["region"])
    for pname, val in [(ac["ssm_runtime_arn"], runtime_arn),
                       (ac["ssm_interpreter_id"], interpreter_id),
                       (ac["ssm_memory_id"], memory_id)]:
        if not val:
            log(f"ssm:{pname}", "SKIP", "empty value")
            continue
        ssm.put_parameter(Name=pname, Value=val, Type="String", Overwrite=True)
        log(f"ssm:{pname}", "WROTE", val[:60])


def smoke(ac, runtime_arn):
    if not runtime_arn:
        log("smoke", "ERR", "no runtime arn")
        return
    data = boto3.client("bedrock-agentcore", region_name=ac["region"])
    payload = json.dumps({"gateway": "security", "prompt": "List the IAM roles in this account. Use the list_roles tool."}).encode()
    try:
        resp = data.invoke_agent_runtime(agentRuntimeArn=runtime_arn, qualifier="DEFAULT",
                                         runtimeSessionId="p1f-smoke-session-000000000000000000000000000000000",
                                         payload=payload)
        body = resp["response"].read().decode() if hasattr(resp.get("response"), "read") else str(resp.get("response"))
        ok = "role" in body.lower()
        log("smoke", "OK" if ok else "WARN", body[:160])
    except ClientError as e:
        log("smoke", "ERR", str(e)[:160])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="invoke the runtime through one gateway after provisioning")
    args = ap.parse_args()

    ac = tf_outputs()
    region = ac["region"]
    ctrl = boto3.client("bedrock-agentcore-control", region_name=region)

    print(f"\n=== AWSops v2 AgentCore provisioner (region={region}) ===")
    gw_ids = ensure_gateways(ctrl, ac)
    # Load the ADR-017 credentials secret ONCE and share it with both calls below — also lets
    # ensure_targets know which legacy lambda targets ensure_mcp_server_targets owns this run (see
    # ensure_targets' skip_names docstring: without this a legacy target flaps every run).
    secrets, secrets_read_ok = _load_official_mcp_secret(ac)
    legacy_skip = {catalog.legacy_target_name(pk) for pk in _cutover_preset_keys(ac, secrets, secrets_read_ok)}
    legacy_skip.discard(None)
    ensure_targets(ctrl, ac, gw_ids, skip_names=legacy_skip)
    ensure_mcp_server_targets(ctrl, ac, gw_ids, secrets=secrets, secrets_read_ok=secrets_read_ok)  # ADR-017 curated official-vendor MCP presets
    prune_moved_targets(ctrl, gw_ids)  # remove split-brain orphans after a catalog gateway move
    memory_id = ensure_memory(ctrl)
    interpreter_id = ensure_interpreter(ctrl)
    runtime_arn = ensure_runtime(ctrl, ac, gw_ids)
    write_ssm(ac, runtime_arn, interpreter_id, memory_id)

    if args.smoke:
        print("\n=== smoke (runtime -> gateway -> tool) ===")
        # the runtime may need a few seconds after create/update to become invokable
        time.sleep(10)
        smoke(ac, runtime_arn)

    errs = [r for r in report if r[1] == "ERR"]
    print(f"\n=== report: {len(report)} actions, {len(errs)} errors ===")
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main()
