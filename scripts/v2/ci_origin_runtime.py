#!/usr/bin/env python3
"""Origin runtime releases, without Terraform/state access from CI.

--component agentcore|worker|steampipe
  prepare -> preflight -> check                         (default check mode)
  prepare -> preflight -> stage-build -> record-build --digest sha256:...
          -> shared private migration run -> migrate --digest ... (AgentCore)
          -> deploy -> cleanup

AWSOPS_RUNTIME_METADATA_JSON is a protected, operator-exported metadata variable.
prepare validates its strict v1 schema and writes CI_RUNTIME_METADATA_FILE,
CI_RUNTIME_MANIFEST, CI_AGENT_CONFIG_FILE and CI_MIGRATION_RECEIPT under a
private run directory. No credentials, raw state or tfvars are accepted.

Pinned ECS images must already match the reviewed Terraform pin. Mutable tags are
promoted without changing task definitions. Worker success requires execution of
a fixed read-only probe in the existing definition, matching image digest, exit
code and nonce-bound database proof. AgentCore success requires the exact pinned
image/version on DEFAULT and the existing structured readiness protocol.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
import uuid
from urllib.parse import urlsplit

import boto3
from botocore.config import Config

from ci_origin_common import command, decode_json, private_bytes, require, ReleaseError, sha256_digest
from ci_origin_migration import Migration

ROOT = Path(__file__).resolve().parents[2]
COMPONENTS = ("agentcore", "worker", "steampipe")
BUILD_CONTEXT = {"agentcore": "agent", "worker": "scripts/v2/workers", "steampipe": "scripts/v2/steampipe"}
AGENT_CHECKS = ("identity", "inventorySummary", "inventoryQuery", "knownResource", "freshInventory", "model")
MIGRATION_KEYS = {"aurora_endpoint", "aurora_database", "aurora_secret_arn", "agent_sql_reader_secret_arn"}
IMAGE_TYPES = {"application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"}
INDEX_TYPES = {"application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"}


def keys(value, expected):
    require(isinstance(value, dict) and set(value) == set(expected), "metadata_fields_invalid")


def identity_scope(account, project, region):
    require(isinstance(account, str) and re.fullmatch(r"\d{12}", account), "invalid_account")
    require(isinstance(project, str) and re.fullmatch(r"[a-z][a-z0-9-]{1,39}", project), "invalid_project")
    require(isinstance(region, str) and re.fullmatch(
        r"(af|ap|ca|eu|il|me|mx|sa|us)-(central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9]\d*", region),
        "invalid_region")


def identifiers(values, prefix):
    require(isinstance(values, list) and 0 < len(values) <= 16 and len(set(values)) == len(values)
            and all(isinstance(v, str) and re.fullmatch(prefix + r"-(?:[0-9a-f]{8}|[0-9a-f]{17})", v)
                    for v in values), "network_metadata_invalid")


def secret_arn(value, account, region):
    return isinstance(value, str) and re.fullmatch(
        rf"arn:aws:secretsmanager:{region}:{account}:secret:[A-Za-z0-9/_+=.@!-]+-[A-Za-z0-9]{{6}}", value)


def validate_agent_config(ac, account, project, region):
    keys(ac, {"project", "region", "ecr_uri", "role_arn", "lambda_arns", "ssm_runtime_arn",
              "ssm_memory_id", "ssm_interpreter_id", "subnets", "security_groups",
              "deployment_readiness_enabled", "official_mcp_endpoints", "official_mcp_read_only_ack",
              "integrations_secret_name"})
    require(ac["project"] == project and ac["region"] == region
            and ac["ecr_uri"] == f"{account}.dkr.ecr.{region}.amazonaws.com/{project}-agentcore"
            and ac["role_arn"] == f"arn:aws:iam::{account}:role/{project}-agentcore", "agent_metadata_scope_mismatch")
    require(type(ac["deployment_readiness_enabled"]) is bool, "agent_metadata_scope_mismatch")
    for key, suffix in (("ssm_runtime_arn", "runtime_arn"), ("ssm_memory_id", "memory_id"),
                        ("ssm_interpreter_id", "interpreter_id")):
        require(ac[key] == f"/ops/{project}/agentcore/{suffix}", "agent_metadata_scope_mismatch")
    identifiers(ac["subnets"], "subnet")
    identifiers(ac["security_groups"], "sg")
    require(isinstance(ac["lambda_arns"], dict) and 0 < len(ac["lambda_arns"]) <= 64, "agent_targets_invalid")
    for name, arn in ac["lambda_arns"].items():
        # Terraform uses function_name = "${var.project}-agent-${each.key}".
        require(isinstance(name, str) and re.fullmatch(r"[a-z0-9-]+", name) and isinstance(arn, str) and
                arn == f"arn:aws:lambda:{region}:{account}:function:{project}-agent-{name}",
                "agent_targets_invalid")
    for key in ("official_mcp_endpoints", "official_mcp_read_only_ack"):
        require(isinstance(ac[key], dict) and set(ac[key]) <= {"datadog", "dynatrace", "newrelic"},
                "curated_mcp_metadata_invalid")
        hosts = {"datadog": ("datadoghq.com", "datadoghq.eu", "ddog-gov.com"),
                 "dynatrace": ("dynatrace.com",), "newrelic": ("newrelic.com",)}
        for preset, value in ac[key].items():
            require(isinstance(value, str) and len(value) <= 2048, "curated_mcp_metadata_invalid")
            u = urlsplit(value)
            require(u.scheme == "https" and u.hostname and not u.username and not u.password
                    and u.port in (None, 443) and not u.query and not u.fragment
                    and any(u.hostname == host or u.hostname.endswith("." + host) for host in hosts[preset]),
                    "curated_mcp_metadata_invalid")
    require(ac["official_mcp_endpoints"] == ac["official_mcp_read_only_ack"], "curated_mcp_ack_missing")
    secret = ac["integrations_secret_name"]
    require(secret is None or secret == f"ops/{project}/integrations/credentials" or (
        secret_arn(secret, account, region) and
        secret.startswith(f"arn:aws:secretsmanager:{region}:{account}:secret:ops/{project}/integrations/credentials-")),
        "agent_secret_scope_mismatch")
    return ac


def load_agent_config(path):
    """Operator provisioner --config entry; structural validation without Terraform."""
    ac = decode_json(private_bytes(Path(path)))
    require(isinstance(ac, dict) and isinstance(ac.get("role_arn"), str), "agent_metadata_scope_mismatch")
    parts = ac["role_arn"].split(":")
    require(len(parts) == 6, "agent_metadata_scope_mismatch")
    account, project, region = parts[4], ac.get("project"), ac.get("region")
    identity_scope(account, project, region)
    return validate_agent_config(ac, account, project, region)


def validate_metadata(meta, account, project, region):
    keys(meta, {"version", "account_id", "project", "region", "migration", "components"})
    require(type(meta["version"]) is int and meta["version"] == 1 and (meta["account_id"], meta["project"], meta["region"]) ==
            (account, project, region), "metadata_scope_mismatch")
    keys(meta["components"], COMPONENTS)
    migration = meta["migration"]
    if migration is not None:
        keys(migration, MIGRATION_KEYS)
        require(isinstance(migration["aurora_endpoint"], str) and re.fullmatch(
            rf"{project}-aurora\.cluster-[a-z0-9-]+\.{region}\.rds\.amazonaws\.com", migration["aurora_endpoint"])
            and migration["aurora_database"] == "awsops", "migration_metadata_invalid")
        require(secret_arn(migration["aurora_secret_arn"], account, region), "migration_metadata_invalid")
        reader = migration["agent_sql_reader_secret_arn"]
        require(reader is None or (secret_arn(reader, account, region) and
                reader.startswith(f"arn:aws:secretsmanager:{region}:{account}:secret:ops/{project}/agent/sql-reader-")),
                "migration_metadata_invalid")
    for component, c in meta["components"].items():
        if c is None:
            continue
        if component == "agentcore":
            keys(c, {"cloudfront_id", "provision"})
            require(isinstance(c["cloudfront_id"], str) and re.fullmatch(r"[A-Z0-9]{5,32}", c["cloudfront_id"]),
                    "cloudfront_metadata_invalid")
            validate_agent_config(c["provision"], account, project, region)
            continue
        expected = {"repository_uri", "cluster_arn", "task_definition_arn", "image"}
        expected |= ({"state_machine_arn", "execution_role_arn", "task_role_arn", "network"}
                     if component == "worker" else {"service_arn"})
        keys(c, expected)
        repository = f"{account}.dkr.ecr.{region}.amazonaws.com/{project}-{component}"
        ecs = f"arn:aws:ecs:{region}:{account}:"
        require(c["repository_uri"] == repository and c["cluster_arn"] == ecs + f"cluster/{project}"
                and isinstance(c["task_definition_arn"], str)
                and re.fullmatch(re.escape(ecs + f"task-definition/{project}-{component}:") + r"[1-9]\d*",
                                 c["task_definition_arn"]), "component_scope_mismatch")
        require(isinstance(c["image"], str) and
                (re.fullmatch(re.escape(repository) + r":[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", c["image"])
                 or (c["image"].startswith(repository + "@") and sha256_digest(c["image"].split("@", 1)[1]))),
                "image_contract_invalid")
        if component == "steampipe":
            require(c["service_arn"] == ecs + f"service/{project}/{project}-steampipe", "component_scope_mismatch")
        else:
            require(c["state_machine_arn"] == f"arn:aws:states:{region}:{account}:stateMachine:{project}-workers"
                    and c["execution_role_arn"] == f"arn:aws:iam::{account}:role/{project}-task-execution"
                    and c["task_role_arn"] == f"arn:aws:iam::{account}:role/{project}-worker-task",
                    "component_scope_mismatch")
            keys(c["network"], {"awsvpcConfiguration"})
            network = c["network"]["awsvpcConfiguration"]
            keys(network, {"subnets", "securityGroups", "assignPublicIp"})
            require(network["assignPublicIp"] == "DISABLED", "public_network_forbidden")
            identifiers(network["subnets"], "subnet")
            identifiers(network["securityGroups"], "sg")
    return meta


def write_private(path, data, exclusive=False):
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | (os.O_EXCL if exclusive else os.O_TRUNC)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(data)


def parsed_smoke(raw, nonce, account):
    """The agent is an async generator: accept JSON or one SSE JSON result, never text heuristics."""
    require(isinstance(raw, bytes) and len(raw) <= 16_384, "agent_smoke_invalid")
    text = raw.decode("utf-8")
    payloads, data = [], []
    if text.lstrip().startswith("{"):
        payloads.append(text)
    else:
        for line in [*text.splitlines(), ""]:
            if not line:
                payload = "\n".join(data).strip()
                if payload and payload != "[DONE]":
                    payloads.append(payload)
                data = []
            elif not line.startswith(":"):
                field, _, value = line.partition(":")
                if field == "data":
                    data.append(value.removeprefix(" "))
                else:
                    require(field in ("event", "id", "retry"), "agent_smoke_invalid")
    require(len(payloads) == 1, "agent_smoke_invalid")
    result = decode_json(payloads[0])
    require(isinstance(result, dict) and set(result) ==
            {"schemaVersion", "mode", "nonce", "accountId", "status", "reason", "checks", "inventory"}
            and type(result.get("schemaVersion")) is int and result.get("schemaVersion") == 1
            and result.get("mode") == "deployment_readiness" and result.get("nonce") == nonce
            and result.get("accountId") == account and result.get("status") == "ready"
            and result.get("reason") == "ok" and isinstance(result.get("checks"), dict)
            and set(result["checks"]) == set(AGENT_CHECKS)
            and all(result["checks"].get(k) is True for k in AGENT_CHECKS), "agent_smoke_failed")
    inventory = result["inventory"]
    require(isinstance(inventory, dict) and set(inventory) == {"count", "ageMinutes"}
            and type(inventory["count"]) is int and 1 <= inventory["count"] <= 500
            and type(inventory["ageMinutes"]) is int and 0 <= inventory["ageMinutes"] <= 1440, "agent_smoke_failed")
    return {key: True for key in AGENT_CHECKS}


class Runtime:
    def __init__(self, component, timeout=900):
        self.component = component
        self.account = os.environ.get("CI_EXPECTED_ACCOUNT_ID", "")
        self.project = os.environ.get("CI_EXPECTED_PROJECT", "")
        self.region = os.environ.get("AWS_REGION", "")
        identity_scope(self.account, self.project, self.region)
        require(os.environ.get("GITHUB_REPOSITORY") == "Atom-oh/awsops"
                and os.environ.get("GITHUB_REF") == "refs/heads/main"
                and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "origin_main_required")
        self.commit = os.environ.get("CI_COMMIT_SHA", "")
        require(re.fullmatch(r"[0-9a-f]{40}", self.commit), "invalid_commit")
        self.source()
        self.mode = os.environ.get("CI_RUNTIME_MODE", "check")
        require(self.mode in ("check", "deploy"), "invalid_mode")
        require(os.environ.get("CI_ROLE_ARN") == f"arn:aws:iam::{self.account}:role/{self.project}-ci-runtime",
                "runtime_role_required")
        require(not any(k.startswith("AWS_ENDPOINT_URL") and v for k, v in os.environ.items()), "endpoint_override")
        run_id, attempt = os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_RUN_ATTEMPT", "")
        require(re.fullmatch(r"\d+", run_id) and re.fullmatch(r"[1-9]\d*", attempt), "run_identity_invalid")
        root = Path(os.environ.get("RUNNER_TEMP", ""))
        require(root.is_absolute() and root.is_dir() and not root.resolve().is_relative_to(ROOT), "private_root_invalid")
        self.directory = root / f"awsops-runtime-{component}-{run_id}-{attempt}"
        require(not self.directory.is_symlink(), "private_directory_invalid")
        self.path = self.directory / "manifest.json"
        self.metadata_path = self.directory / "metadata.json"
        self.owner = f"{run_id}:{attempt}:{component}"
        self.context = dict(commit=self.commit, account=self.account, region=self.region,
                            project=self.project, component=component, owner=self.owner, mode=self.mode)
        self.deadline = None
        require(1 <= timeout <= 1800, "timeout_invalid")
        self.timeout = timeout
        self.meta = None
        self.c = None

    def source(self):
        require(command(["git", "rev-parse", "HEAD"]) == self.commit, "source_moved")

    def aws(self, service, operation, *args):
        timeout = min(60, self.deadline - time.monotonic()) if self.deadline else 60
        require(timeout > 0, "runtime_timeout")
        result = decode_json(command(["aws", service, operation, *args, "--region", self.region,
                                      "--output", "json", "--no-cli-pager", "--cli-connect-timeout", "5",
                                      "--cli-read-timeout", "30"], timeout=timeout))
        require(isinstance(result, dict), "aws_response_invalid")
        return result

    def scope(self):
        identity = self.aws("sts", "get-caller-identity")
        require(identity.get("Account") == self.account and isinstance(identity.get("Arn"), str) and
                re.fullmatch(rf"arn:aws:sts::{self.account}:assumed-role/{self.project}-ci-runtime/[A-Za-z0-9+=,.@_-]+",
                             identity["Arn"]), "caller_scope_mismatch")

    def metadata(self):
        require(os.environ.get("CI_RUNTIME_METADATA_FILE") == str(self.metadata_path), "metadata_path_mismatch")
        require(private_bytes(self.directory / ".owner").decode() == self.owner, "private_owner_mismatch")
        self.meta = validate_metadata(decode_json(private_bytes(self.metadata_path)),
                                      self.account, self.project, self.region)
        self.c = self.meta["components"][self.component]
        require(self.c is not None, "component_requires_reviewed_infrastructure")
        self.repository = (self.c["provision"]["ecr_uri"] if self.component == "agentcore" else self.c["repository_uri"])
        self.repo_name = self.project + "-" + self.component
        self.metadata_hash = hashlib.sha256(json.dumps(self.meta, sort_keys=True).encode()).hexdigest()

    def prepare(self):
        meta = validate_metadata(decode_json(os.environ.get("AWSOPS_RUNTIME_METADATA_JSON", "")),
                                 self.account, self.project, self.region)
        require(meta["components"][self.component] is not None, "component_requires_reviewed_infrastructure")
        self.directory.mkdir(mode=0o700)
        write_private(self.directory / ".owner", self.owner, exclusive=True)
        write_private(self.metadata_path, json.dumps(meta), exclusive=True)
        ac = meta["components"]["agentcore"]
        write_private(self.directory / "agent.json", json.dumps(ac["provision"] if ac else None), exclusive=True)
        deny = self.directory / "bin"
        deny.mkdir(mode=0o700)
        write_private(deny / "terraform", "#!/bin/sh\nexit 97\n", exclusive=True)
        (deny / "terraform").chmod(0o700)
        fields = {"CI_RUNTIME_METADATA_FILE": str(self.metadata_path), "CI_RUNTIME_MANIFEST": str(self.path),
                  "CI_AGENT_CONFIG_FILE": str(self.directory / "agent.json"),
                  "CI_MIGRATION_RECEIPT": str(self.directory / "migration-receipt.json")}
        with open(os.environ["GITHUB_ENV"], "a") as file:
            for key, value in fields.items():
                require("\n" not in value and "\r" not in value, "private_path_invalid")
                file.write(f"{key}={value}\n")
        return {"status": "prepared"}

    def save(self, state):
        if self.path.exists() or self.path.is_symlink():
            private_bytes(self.path)
        with tempfile.NamedTemporaryFile(mode="w", dir=self.directory, delete=False) as file:
            temp = file.name
            json.dump(state, file, sort_keys=True)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp, self.path)

    def load(self, *stages):
        self.metadata()
        self.scope()
        state = decode_json(private_bytes(self.path))
        require(state.get("context") == self.context and state.get("metadata_hash") == self.metadata_hash,
                "release_context_mismatch")
        require(state.get("stage") in stages, "release_order_invalid")
        return state

    def preflight(self):
        self.metadata()
        self.scope()
        require(not self.path.exists(), "manifest_exists")
        snapshot = self.snapshot()
        self.save({"context": self.context, "metadata_hash": self.metadata_hash,
                   "nonce": uuid.uuid4().hex, "stage": "preflight", "snapshot": snapshot})
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"repository_uri={self.repository}\nbuild_context={BUILD_CONTEXT[self.component]}\n")
            output.write(f"source_tag={self.component}-{self.commit}\n")
            if self.component == "agentcore":
                output.write(f"migration_repository_uri={self.migration_controller().repo}\n")
        return {"status": "preflight_ok"}

    def definition(self, ref=None):
        result = self.aws("ecs", "describe-task-definition", "--task-definition", ref or self.c["task_definition_arn"])
        td = result.get("taskDefinition", {})
        require(td.get("taskDefinitionArn") == self.c["task_definition_arn"] and td.get("status") == "ACTIVE"
                and td.get("runtimePlatform") == {"cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX"},
                "task_definition_drift")
        containers = [c for c in td.get("containerDefinitions", []) if c.get("name") == self.component]
        require(len(containers) == 1 and containers[0].get("image") == self.c["image"]
                and containers[0].get("essential") is True, "image_contract_drift")
        if self.component == "worker":
            require(td.get("executionRoleArn") == self.c["execution_role_arn"]
                    and td.get("taskRoleArn") == self.c["task_role_arn"], "task_role_drift")
            log = containers[0].get("logConfiguration", {})
            require(log.get("logDriver") == "awslogs" and log.get("options", {}) ==
                    {"awslogs-group": f"/ecs/{self.project}-worker", "awslogs-region": self.region,
                     "awslogs-stream-prefix": "worker"}, "worker_log_contract_invalid")
        else:
            require(containers[0].get("healthCheck", {}).get("command"), "steampipe_healthcheck_missing")
        return td

    def worker_contract(self):
        self.definition()
        self.definition(self.project + "-worker")  # SFN consumes the latest ACTIVE family revision.
        response = self.aws("states", "describe-state-machine", "--state-machine-arn", self.c["state_machine_arn"])
        require(response.get("stateMachineArn") == self.c["state_machine_arn"] and response.get("status") == "ACTIVE",
                "worker_state_machine_invalid")
        definition = decode_json(response.get("definition", ""))
        task = definition.get("States", {}).get("RunFargate", {})
        params = task.get("Parameters", {})
        network = self.c["network"]["awsvpcConfiguration"]
        require(task.get("Resource") == "arn:aws:states:::ecs:runTask.sync"
                and params.get("Cluster") == self.c["cluster_arn"]
                and params.get("TaskDefinition") == self.project + "-worker"
                and params.get("NetworkConfiguration") == {"AwsvpcConfiguration": {
                    "Subnets": network["subnets"], "SecurityGroups": network["securityGroups"], "AssignPublicIp": "DISABLED"}},
                "worker_consumer_drift")
        return {"task_definition": self.c["task_definition_arn"], "image": self.c["image"]}

    def steam_service(self, expected=None):
        result = self.aws("ecs", "describe-services", "--cluster", self.c["cluster_arn"],
                          "--services", self.c["service_arn"])
        require(not result.get("failures") and len(result.get("services", [])) == 1, "service_unavailable")
        service = result["services"][0]
        require(service.get("serviceArn") == self.c["service_arn"] and service.get("clusterArn") == self.c["cluster_arn"]
                and service.get("taskDefinition") == self.c["task_definition_arn"] and service.get("status") == "ACTIVE",
                "service_drift")
        primary = [d for d in service.get("deployments", []) if d.get("status") == "PRIMARY"]
        require(len(primary) == 1 and isinstance(primary[0].get("id"), str), "deployment_missing")
        primary = primary[0]
        require(expected is None or primary["id"] == expected, "deployment_replaced_or_rolled_back")
        require(primary.get("rolloutState") in ("IN_PROGRESS", "COMPLETED"), "deployment_failed")
        return service, primary

    @staticmethod
    def stable(service, primary):
        count = service.get("desiredCount")
        require(type(count) is int and 0 < count <= 100 and service.get("runningCount") == count
                and service.get("pendingCount") == 0 and primary.get("runningCount") == count
                and primary.get("desiredCount") == count and primary.get("pendingCount") == 0
                and primary.get("rolloutState") == "COMPLETED", "deployment_not_stable")

    def parameter(self, name):
        result = self.aws("ssm", "get-parameter", "--name", name).get("Parameter", {})
        require(result.get("Name") == name and result.get("Type") == "String"
                and isinstance(result.get("Value"), str) and result["Value"], "agent_parameter_unavailable")
        return result["Value"]

    def agent_runtime(self):
        ac = self.c["provision"]
        arn = self.parameter(ac["ssm_runtime_arn"])
        if arn == "PENDING":
            return None  # Foundation metadata exists; first provisioning has not run.
        prefix = f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:runtime/{self.project.replace('-', '_')}_agent-"
        require(arn.startswith(prefix) and re.fullmatch(r"[A-Za-z0-9_-]+", arn.rsplit("/", 1)[1]), "agent_runtime_scope_mismatch")
        result = self.aws("bedrock-agentcore-control", "get-agent-runtime", "--agent-runtime-id", arn.rsplit("/", 1)[1])
        require(result.get("agentRuntimeArn") == arn and result.get("roleArn") == ac["role_arn"],
                "agent_runtime_scope_mismatch")
        network = result.get("networkConfiguration", {})
        config = network.get("networkModeConfig", {})
        require(network.get("networkMode") == "VPC" and set(config.get("subnets", [])) == set(ac["subnets"])
                and set(config.get("securityGroups", [])) == set(ac["security_groups"]),
                "agent_network_requires_reviewed_infrastructure")
        require(isinstance(result.get("agentRuntimeVersion"), str)
                and re.fullmatch(r"[1-9]\d*", result["agentRuntimeVersion"]), "agent_version_missing")
        require(result.get("environmentVariables", {}).get("CLICKHOUSE_OFFICIAL_MCP", "false") == "false",
                "frozen_flag_detected")
        require(result.get("environmentVariables", {}).get("ANTHROPIC_AGENT_LOOP_ENABLED", "false") in ("true", "false"),
                "agent_feature_configuration_invalid")
        return result

    def migration_controller(self):
        require(os.environ.get("CI_MIGRATION_RECEIPT") == str(self.directory / "migration-receipt.json"),
                "migration_receipt_path_mismatch")
        return Migration()

    def migration_source(self):
        migration = self.meta["migration"]
        require(migration is not None, "migration_metadata_required")
        expected = {"version": 1, "commit": self.commit, "account": self.account,
                    "region": self.region, "project": self.project,
                    "database": migration["aurora_database"], "endpoint": migration["aurora_endpoint"],
                    "secret_arn": migration["aurora_secret_arn"],
                    "sql_reader_secret_arn": migration["agent_sql_reader_secret_arn"]}
        require(self.migration_controller().target() == expected, "migration_resource_mismatch")
        return expected

    def snapshot(self):
        if self.component == "worker":
            return self.worker_contract()
        if self.component == "steampipe":
            self.definition()
            service, primary = self.steam_service()
            self.stable(service, primary)
            return {"deployment_id": primary["id"], "task_definition": service["taskDefinition"],
                    "desired_count": service["desiredCount"]}
        require(self.project == "awsops-v2", "agent_catalog_project_requires_operator_migration")
        require(self.c["provision"]["deployment_readiness_enabled"], "agent_readiness_requires_reviewed_apply")
        require(self.meta["migration"] is not None and self.meta["migration"]["agent_sql_reader_secret_arn"],
                "agent_migration_metadata_required")
        self.migration_source()
        current = self.agent_runtime()
        if current is None:
            return {"runtime_arn": None, "version": None, "loop_enabled": "false"}
        require(current.get("status") == "READY", "agent_not_ready")
        return {"runtime_arn": current["agentRuntimeArn"], "version": current["agentRuntimeVersion"],
                "loop_enabled": current.get("environmentVariables", {}).get("ANTHROPIC_AGENT_LOOP_ENABLED", "false")}

    def check(self):
        state = self.load("preflight")
        require(self.snapshot() == state["snapshot"], "component_moved")
        require(self.component != "agentcore" or state["snapshot"]["runtime_arn"] is not None,
                "agent_requires_initial_deploy")
        return {"status": "checked", "execution": "not_run"}

    def stage_build(self):
        self.load("preflight")
        require(self.mode == "deploy", "deploy_mode_required")
        if self.component == "worker":
            for name in ("action_catalog.py", "remediation_executor.py", "remediation_executor_cli.py"):
                target = ROOT / "scripts/v2/workers" / name
                require(not target.is_symlink(), "build_context_symlink")
                shutil.copyfile(ROOT / "scripts/v2/remediation" / name, target)
        return {"status": "build_context_ready"}

    def image(self, reference):
        result = self.aws("ecr", "batch-get-image", "--registry-id", self.account,
                          "--repository-name", self.repo_name, "--image-ids", reference)
        require(not result.get("failures") and len(result.get("images", [])) == 1, "image_unavailable")
        image = result["images"][0]
        digest = image.get("imageId", {}).get("imageDigest")
        raw = image.get("imageManifest")
        key, value = reference.split("=", 1)
        require(image.get("registryId") == self.account and image.get("repositoryName") == self.repo_name
                and image.get("imageId", {}).get(key) == value and sha256_digest(digest)
                and isinstance(raw, str) and "sha256:" + hashlib.sha256(raw.encode()).hexdigest() == digest,
                "image_binding_failed")
        body = decode_json(raw)
        require(body.get("schemaVersion") == 2 and body.get("mediaType") == image.get("imageManifestMediaType"),
                "image_manifest_invalid")
        return digest, raw, body

    def build_proof(self, digest):
        require(sha256_digest(digest), "invalid_digest")
        actual, raw, body = self.image("imageTag=" + self.component + "-" + self.commit)
        require(actual == digest, "source_image_mismatch")
        arm = digest
        if body["mediaType"] in INDEX_TYPES:
            children = body.get("manifests", [])
            require(isinstance(children, list) and 0 < len(children) <= 32, "image_index_invalid")
            matches = [c for c in children if c.get("platform", {}).get("os") == "linux"
                       and c.get("platform", {}).get("architecture") == "arm64"
                       and c["platform"].get("variant") in (None, "v8")]
            require(len(matches) == 1 and sha256_digest(matches[0].get("digest")), "arm64_image_missing")
            arm, _, body = self.image("imageDigest=" + matches[0]["digest"])
        require(body.get("mediaType") in IMAGE_TYPES and sha256_digest(body.get("config", {}).get("digest"))
                and isinstance(body.get("layers"), list), "image_manifest_invalid")
        return {"digest": digest, "arm64_digest": arm, "commit": self.commit}, raw

    def record_build(self, digest):
        state = self.load("preflight")
        require(self.mode == "deploy", "deploy_mode_required")
        state["build"], _ = self.build_proof(digest)
        state["stage"] = "built"
        self.save(state)
        return {"status": "build_recorded", "digest": digest}

    def migration_proof(self, state):
        proof = state.get("migration", {})
        require(proof.get("commit") == self.commit and proof.get("status") == "succeeded"
                and sha256_digest(proof.get("digest")), "migration_proof_missing")
        receipt = self.migration_controller().verify_receipt(self.migration_source(), "apply")
        require(receipt["digest"] == proof["digest"], "migration_digest_mismatch")
        return receipt

    def migrate(self, digest):
        state = self.load("built")
        require(self.mode == "deploy" and self.component == "agentcore", "agent_migration_only")
        self.build_proof(state["build"]["digest"])
        require(sha256_digest(digest), "invalid_migration_digest")
        receipt = self.migration_controller().verify_receipt(self.migration_source(), "apply")
        require(receipt["digest"] == digest, "migration_digest_mismatch")
        self.source()
        state.update(stage="migrated", migration={"commit": self.commit, "status": "succeeded", "digest": digest})
        self.save(state)
        return {"status": "migrated"}

    def promote(self, state, raw):
        image = self.c["image"]
        digest = state["build"]["digest"]
        if "@" in image:
            require(image == self.repository + "@" + digest, "image_pin_requires_reviewed_apply")
            return
        tag = image.rsplit(":", 1)[1]
        if re.fullmatch(re.escape(self.component) + r"-[0-9a-f]{40}", tag):
            require(tag == self.component + "-" + self.commit
                    and self.image("imageTag=" + tag)[0] == digest, "image_pin_requires_reviewed_apply")
            return
        old, _, _ = self.image("imageTag=" + tag)
        if old != digest:
            result = self.aws("ecr", "put-image", "--registry-id", self.account,
                              "--repository-name", self.repo_name, "--image-tag", tag,
                              "--image-manifest", raw, "--image-manifest-media-type", decode_json(raw)["mediaType"],
                              "--image-digest", digest)
            require(result.get("image", {}).get("imageId", {}).get("imageDigest") == digest, "promotion_failed")
        require(self.image("imageTag=" + tag)[0] == digest, "promotion_failed")

    def task(self, state):
        arn = state["probe"]["task_arn"]
        require(re.fullmatch(re.escape(f"arn:aws:ecs:{self.region}:{self.account}:task/{self.project}/") +
                             r"[0-9a-f]{32}", arn), "probe_scope_mismatch")
        while True:
            result = self.aws("ecs", "describe-tasks", "--cluster", self.c["cluster_arn"], "--tasks", arn, "--include", "TAGS")
            tasks, failures = result.get("tasks", []), result.get("failures", [])
            require(isinstance(tasks, list) and isinstance(failures, list), "probe_unavailable")
            if tasks:
                require(not failures and len(tasks) == 1 and isinstance(tasks[0], dict), "probe_unavailable")
                break
            require(len(failures) <= 1 and all(isinstance(f, dict) and f.get("arn") == arn
                    and f.get("reason") == "MISSING" for f in failures), "probe_unavailable")
            self.pause()  # Deployment and cleanup both supply a bounded deadline.
        task = tasks[0]
        tags = {t["key"]: t["value"] for t in task.get("tags", [])}
        require(task.get("taskArn") == arn and task.get("clusterArn") == self.c["cluster_arn"]
                and task.get("taskDefinitionArn") == self.c["task_definition_arn"]
                and task.get("startedBy") == "ci-" + state["nonce"]
                and task.get("group") == "ci-runtime-" + state["nonce"]
                and all(tags.get(k) == v for k, v in self.probe_tags(state).items()), "probe_owner_mismatch")
        return task

    def probe_tags(self, state):
        return {"awsops:project": self.project, "awsops:purpose": "ci-runtime-probe", "awsops:release": state["nonce"]}

    def pause(self):
        remaining = self.deadline - time.monotonic()
        require(remaining > 0, "runtime_timeout")
        time.sleep(min(5, remaining))

    def deploy_worker(self, state):
        params = {"cluster": self.c["cluster_arn"], "taskDefinition": self.c["task_definition_arn"],
                  "count": 1, "launchType": "FARGATE", "networkConfiguration": self.c["network"],
                  "startedBy": "ci-" + state["nonce"], "group": "ci-runtime-" + state["nonce"],
                  "enableExecuteCommand": False, "tags": [{"key": k, "value": v} for k, v in self.probe_tags(state).items()],
                  "overrides": {"containerOverrides": [{"name": "worker",
                                 "command": ["python", "fargate_worker.py", "--ci-probe", state["nonce"]]}]}}
        response = self.aws("ecs", "run-task", "--cli-input-json", json.dumps(params))
        require(not response.get("failures") and len(response.get("tasks", [])) == 1, "probe_start_failed")
        state["probe"] = {"task_arn": response["tasks"][0]["taskArn"]}
        self.save(state)
        while True:
            task = self.task(state)
            if task.get("lastStatus") == "STOPPED":
                break
            self.pause()
        web = [c for c in task.get("containers", []) if c.get("name") == "worker"]
        require(len(web) == 1 and web[0].get("exitCode") == 0 and web[0].get("lastStatus") == "STOPPED"
                and web[0].get("image") == self.c["image"]
                and web[0].get("imageDigest") in (state["build"]["digest"], state["build"]["arm64_digest"]),
                "worker_probe_failed")
        stream = "worker/worker/" + state["probe"]["task_arn"].rsplit("/", 1)[1]
        while True:
            logs = self.aws("logs", "get-log-events", "--log-group-name", f"/ecs/{self.project}-worker",
                            "--log-stream-name", stream, "--start-from-head", "--limit", "100", "--no-paginate")
            found = False
            for event in logs.get("events", []):
                try:
                    proof = decode_json(event.get("message", ""))
                except ReleaseError:
                    continue
                checks = proof.get("checks") if isinstance(proof, dict) else None
                if (isinstance(proof, dict) and proof.get("mode") == "ci_runtime_probe"
                        and proof.get("nonce") == state["nonce"] and proof.get("status") == "ok"
                        and isinstance(checks, dict) and set(checks) == {"startup", "database", "schema"}
                        and all(value is True for value in checks.values())):
                    found = True
            if found:
                break
            self.pause()
        self.worker_contract()
        return {"task_arn": task["taskArn"], "checks": ["startup", "database", "schema"]}

    def deploy_steampipe(self, state):
        result = self.aws("ecs", "update-service", "--cluster", self.c["cluster_arn"],
                          "--service", self.c["service_arn"], "--force-new-deployment")
        deployments = [d for d in result.get("service", {}).get("deployments", []) if d.get("status") == "PRIMARY"]
        require(result.get("service", {}).get("serviceArn") == self.c["service_arn"]
                and len(deployments) == 1 and isinstance(deployments[0].get("id"), str)
                and re.fullmatch(r"ecs-svc/[0-9]+", deployments[0]["id"])
                and deployments[0]["id"] != state["snapshot"]["deployment_id"], "new_deployment_missing")
        new_id = deployments[0]["id"]
        state["deployment_id"] = new_id
        self.save(state)
        while True:
            service, primary = self.steam_service(new_id)
            if primary["rolloutState"] == "COMPLETED":
                self.stable(service, primary)
                break
            self.pause()
        tasks = self.aws("ecs", "list-tasks", "--cli-input-json", json.dumps({
            "cluster": self.c["cluster_arn"], "serviceName": self.project + "-steampipe",
            "desiredStatus": "RUNNING", "maxResults": 100}), "--no-paginate")
        arns = tasks.get("taskArns", [])
        require(not tasks.get("nextToken") and len(arns) == service["desiredCount"] and arns, "service_tasks_missing")
        result = self.aws("ecs", "describe-tasks", "--cluster", self.c["cluster_arn"], "--tasks", *arns)
        require(not result.get("failures") and len(result.get("tasks", [])) == len(arns), "service_tasks_missing")
        for task in result["tasks"]:
            containers = [c for c in task.get("containers", []) if c.get("name") == "steampipe"]
            require(task.get("taskArn") in arns and task.get("clusterArn") == self.c["cluster_arn"]
                    and task.get("taskDefinitionArn") == self.c["task_definition_arn"]
                    and task.get("startedBy") == new_id and task.get("lastStatus") == "RUNNING"
                    and task.get("healthStatus") == "HEALTHY" and len(containers) == 1
                    and containers[0].get("healthStatus") == "HEALTHY"
                    and containers[0].get("imageDigest") in (state["build"]["digest"], state["build"]["arm64_digest"]),
                    "steampipe_consumption_failed")
        self.stable(*self.steam_service(new_id))
        return {"deployment_id": new_id, "healthy_tasks": len(arns)}

    def deploy_agent(self, state):
        self.migration_proof(state)
        env = dict(os.environ)
        env["PATH"] = str(self.directory / "bin") + os.pathsep + os.environ.get("PATH", os.defpath)
        env["CLICKHOUSE_OFFICIAL_MCP"] = "false"
        env["ANTHROPIC_AGENT_LOOP_ENABLED"] = state["snapshot"]["loop_enabled"]
        env["AGENTCORE_RUNTIME_READY_TIMEOUT"] = "300"
        command(["python3", "scripts/v2/agentcore/provision.py", "--config", str(self.directory / "agent.json"),
                 "--image", self.repository + "@" + state["build"]["digest"]], env=env, timeout=900)
        while True:
            current = self.agent_runtime()
            if current is None:
                self.pause()
                continue
            require(current.get("agentRuntimeArtifact", {}).get("containerConfiguration", {}).get("containerUri") ==
                    self.repository + "@" + state["build"]["digest"], "agent_image_mismatch")
            require(current.get("status") in ("READY", "UPDATING", "CREATING"), "agent_failed")
            endpoint = self.aws("bedrock-agentcore-control", "get-agent-runtime-endpoint",
                                "--agent-runtime-id", current["agentRuntimeId"], "--endpoint-name", "DEFAULT")
            if (current["status"] == "READY" and endpoint.get("status") == "READY"
                    and endpoint.get("name") == "DEFAULT"
                    and endpoint.get("agentRuntimeArn") == current["agentRuntimeArn"]
                    and endpoint.get("liveVersion") == current.get("agentRuntimeVersion")):
                break
            self.pause()
        payload = {"mode": "deployment_readiness", "nonce": state["nonce"],
                   "expectedAccountId": self.account, "expectedCloudfrontId": self.c["cloudfront_id"]}
        client = boto3.client("bedrock-agentcore", region_name=self.region, config=Config(
            connect_timeout=5, read_timeout=60, retries={"total_max_attempts": 1, "mode": "standard"},
            ignore_configured_endpoint_urls=True))
        response = client.invoke_agent_runtime(agentRuntimeArn=current["agentRuntimeArn"], qualifier="DEFAULT",
                                                runtimeSessionId="ci-runtime-" + state["nonce"],
                                                contentType="application/json", payload=json.dumps(payload).encode())
        require(response.get("statusCode") == 200, "agent_smoke_failed")
        body = response["response"]
        try:
            proof = parsed_smoke(body.read(16_384 + 1), state["nonce"], self.account)
        finally:
            body.close()
        require(self.agent_runtime().get("agentRuntimeVersion") == current["agentRuntimeVersion"], "agent_version_moved")
        endpoint = self.aws("bedrock-agentcore-control", "get-agent-runtime-endpoint",
                            "--agent-runtime-id", current["agentRuntimeId"], "--endpoint-name", "DEFAULT")
        require(endpoint.get("status") == "READY" and endpoint.get("liveVersion") == current["agentRuntimeVersion"]
                and endpoint.get("agentRuntimeArn") == current["agentRuntimeArn"], "agent_endpoint_moved")
        return {"runtime_arn": current["agentRuntimeArn"], "runtime_version": current["agentRuntimeVersion"], "checks": proof}

    def deploy(self):
        state = self.load("built", "migrated")
        require(self.mode == "deploy", "deploy_mode_required")
        if self.component == "agentcore":
            self.migration_proof(state)
        require(self.snapshot() == state["snapshot"], "component_moved")
        build, raw = self.build_proof(state["build"]["digest"])
        require(build == state["build"], "image_proof_mismatch")
        self.deadline = time.monotonic() + self.timeout
        if self.component == "agentcore":
            proof = self.deploy_agent(state)
        else:
            self.promote(state, raw)
            require(self.snapshot() == state["snapshot"], "component_moved")
            proof = self.deploy_worker(state) if self.component == "worker" else self.deploy_steampipe(state)
        self.source()
        self.build_proof(build["digest"])
        state.update(stage="complete", release={**proof, "digest": build["digest"], "commit": self.commit})
        self.save(state)
        return {"status": "complete", "digest": build["digest"]}

    def cleanup(self):
        if not self.directory.exists():
            return {"status": "cleaned"}
        require(private_bytes(self.directory / ".owner").decode() == self.owner, "private_owner_mismatch")
        if self.component == "agentcore" and (self.directory / "migration-receipt.json").exists():
            # Shared ownership/stop checks must succeed before local evidence is
            # removed. The shared helper retains immutable revisions for audit.
            self.migration_controller().cleanup()
        if self.path.exists():
            state = self.load("preflight", "built", "migrated", "complete")
            if self.component == "worker" and state.get("probe"):
                self.deadline = time.monotonic() + 60
                task = self.task(state)
                if task.get("lastStatus") != "STOPPED":
                    self.aws("ecs", "stop-task", "--cluster", self.c["cluster_arn"],
                             "--task", task["taskArn"], "--reason", "CI runtime probe cleanup")
                    while self.task(state).get("lastStatus") != "STOPPED":
                        self.pause()
        shutil.rmtree(self.directory)
        return {"status": "cleaned"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--component", required=True, choices=COMPONENTS)
    sub = parser.add_subparsers(dest="step", required=True)
    for name in ("prepare", "preflight", "check", "stage-build", "cleanup"):
        sub.add_parser(name)
    sub.add_parser("migrate").add_argument("--digest", required=True)
    sub.add_parser("record-build").add_argument("--digest", required=True)
    sub.add_parser("deploy").add_argument("--timeout-seconds", type=int, default=900)
    args = parser.parse_args(argv)
    previous = logging.root.manager.disable
    logging.disable(logging.CRITICAL)
    try:
        controller = Runtime(args.component, getattr(args, "timeout_seconds", 900))
        if args.step in ("record-build", "migrate"):
            result = getattr(controller, args.step.replace("-", "_"))(args.digest)
        else:
            result = getattr(controller, args.step.replace("-", "_"))()
        print(json.dumps({"component": args.component, "step": args.step, **result}, sort_keys=True))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, ReleaseError) else "runtime_operation_failed"
        if not re.fullmatch("[a-z_]+", code):
            code = "runtime_operation_failed"
        print(json.dumps({"component": args.component, "step": args.step, "status": "failed", "error": code}))
        return 1
    finally:
        logging.disable(previous)


if __name__ == "__main__":
    raise SystemExit(main())
