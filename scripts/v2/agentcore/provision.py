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
import json
import os
import subprocess
import sys
import time

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


def ensure_targets(ctrl, ac, gw_ids):
    """Slice targets, idempotent by name. update_gateway_target on tool-schema drift."""
    for tname, spec in catalog.TARGETS.items():
        gw_id = gw_ids.get(spec["gateway"])
        if not gw_id:
            log(f"target:{tname}", "ERR", f"gateway {spec['gateway']} missing")
            continue
        lambda_arn = ac["lambda_arns"].get(spec["lambda_key"])
        if not lambda_arn:
            log(f"target:{tname}", "ERR", f"lambda {spec['lambda_key']} not in tf output")
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
           "AWSOPS_HOST_ACCOUNT_ID": ac["role_arn"].split(":")[4]}
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
    ensure_targets(ctrl, ac, gw_ids)
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
