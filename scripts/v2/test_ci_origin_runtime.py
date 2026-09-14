"""Offline component-release tests; mock CLI/SDK/database boundaries only."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import yaml

import ci_origin_runtime as runtime
import ci_origin_migration as migration

ACCOUNT = "123456789012"
REGION = "ap-northeast-2"
PROJECT = "awsops-v2"
SHA = "a" * 40
ROLE = f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-ci-runtime"
ECS = f"arn:aws:ecs:{REGION}:{ACCOUNT}:"
AC = f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:"
CLUSTER = ECS + "cluster/" + PROJECT
TASK = ECS + "task/" + PROJECT + "/" + "1" * 32
RUNTIME_ID = "awsops_v2_agent-ABCDEFGHIJ"
RUNTIME_ARN = AC + "runtime/" + RUNTIME_ID
SENSITIVE = "private-error-body-do-not-log"
IMAGE_TYPE = "application/vnd.oci.image.manifest.v1+json"
IMAGE_RAW = json.dumps({"schemaVersion": 2, "mediaType": IMAGE_TYPE,
                       "config": {"digest": "sha256:" + "b" * 64}, "layers": []})
DIGEST = "sha256:" + hashlib.sha256(IMAGE_RAW.encode()).hexdigest()
OLD_RAW = IMAGE_RAW.replace("b" * 64, "c" * 64)
OLD_DIGEST = "sha256:" + hashlib.sha256(OLD_RAW.encode()).hexdigest()
MIGRATION_DIGEST = OLD_DIGEST
MIGRATION_TASK = ECS + "task/" + PROJECT + "/" + "2" * 32
NETWORK = {"awsvpcConfiguration": {"subnets": ["subnet-0123456789abcdef0"],
                                   "securityGroups": ["sg-0123456789abcdef0"], "assignPublicIp": "DISABLED"}}
# Real ai.tf agent_lambdas keys: both MCP suffixes and ordinary helper names.
LAMBDA_KEYS = ("iam-mcp", "network-mcp", "flow-monitor", "core-helpers",
               "reachability-read", "istio-read", "aws-knowledge", "inventory-read")


def repo(component):
    return f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/{PROJECT}-{component}"


def metadata():
    return {
        "version": 1, "account_id": ACCOUNT, "project": PROJECT, "region": REGION,
        "migration": {
            "aurora_endpoint": f"{PROJECT}-aurora.cluster-abc.{REGION}.rds.amazonaws.com",
            "aurora_database": "awsops",
            "aurora_secret_arn": f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:rds!cluster-example-AbCd12",
            "agent_sql_reader_secret_arn": f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:ops/{PROJECT}/agent/sql-reader-AbCd12",
        },
        "components": {
            "worker": {
                "repository_uri": repo("worker"), "cluster_arn": CLUSTER,
                "task_definition_arn": ECS + f"task-definition/{PROJECT}-worker:7",
                "state_machine_arn": f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:{PROJECT}-workers",
                "image": repo("worker") + ":worker-latest",
                "execution_role_arn": f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-task-execution",
                "task_role_arn": f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-worker-task",
                "network": copy.deepcopy(NETWORK),
            },
            "steampipe": {
                "repository_uri": repo("steampipe"), "cluster_arn": CLUSTER,
                "task_definition_arn": ECS + f"task-definition/{PROJECT}-steampipe:4",
                "service_arn": ECS + f"service/{PROJECT}/{PROJECT}-steampipe",
                "image": repo("steampipe") + ":steampipe-latest",
            },
            "agentcore": {
                "cloudfront_id": "E123456789",
                "provision": {
                    "project": PROJECT, "region": REGION, "ecr_uri": repo("agentcore"),
                    "role_arn": f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-agentcore",
                    "lambda_arns": {
                        key: f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{PROJECT}-agent-{key}"
                        for key in LAMBDA_KEYS
                    },
                    "ssm_runtime_arn": f"/ops/{PROJECT}/agentcore/runtime_arn",
                    "ssm_memory_id": f"/ops/{PROJECT}/agentcore/memory_id",
                    "ssm_interpreter_id": f"/ops/{PROJECT}/agentcore/interpreter_id",
                    "subnets": NETWORK["awsvpcConfiguration"]["subnets"],
                    "security_groups": NETWORK["awsvpcConfiguration"]["securityGroups"],
                    "deployment_readiness_enabled": True,
                    "official_mcp_endpoints": {}, "official_mcp_read_only_ack": {},
                    "integrations_secret_name": None,
                },
            },
        },
    }


def migration_config():
    return {
        "version": 1, "account": ACCOUNT, "region": REGION, "project": PROJECT,
        "subnets": NETWORK["awsvpcConfiguration"]["subnets"],
        "security_group": NETWORK["awsvpcConfiguration"]["securityGroups"][0],
        "master_secret_arn": metadata()["migration"]["aurora_secret_arn"],
        "sql_reader_secret_arn": metadata()["migration"]["agent_sql_reader_secret_arn"],
        "task_role_arn": f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-ci-migration-task",
        "execution_role_arn": f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-ci-migration-execution",
        "log_group": f"/ecs/{PROJECT}-ci-migration",
    }


class FakeCLI:
    def __init__(self):
        self.calls = []
        self.account = ACCOUNT
        self.head = SHA
        self.untracked_migration_inputs = ""
        self.meta = metadata()
        self.tags = {kind: {kind + "-" + SHA: DIGEST, kind + "-latest": OLD_DIGEST}
                     for kind in ("worker", "steampipe", "agentcore")}
        self.manifests = {DIGEST: IMAGE_RAW, OLD_DIGEST: OLD_RAW}
        self.deployment = "ecs-svc/1111111111111111111"
        self.task = None
        self.task_responses = []
        self.probe_ok = True
        self.probe_log_ok = True
        self.roll_back = False
        self.family_moved = False
        self.migration_task = None
        self.artifact = repo("agentcore") + "@" + OLD_DIGEST
        self.version = "1"
        self.endpoint_version = None
        self.agent_status = "READY"
        self.runtime_provisioned = True
        self.current_loop = "false"
        self.current_network = {"networkMode": "VPC", "networkModeConfig": {
            "subnets": NETWORK["awsvpcConfiguration"]["subnets"],
            "securityGroups": NETWORK["awsvpcConfiguration"]["securityGroups"]}}

    def definition(self, component):
        c = self.meta["components"][component]
        return {
            "taskDefinitionArn": c["task_definition_arn"],
            "family": PROJECT + "-" + component, "status": "ACTIVE",
            "runtimePlatform": {"cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX"},
            "containerDefinitions": [{
                "name": component, "image": c["image"], "essential": True,
                "healthCheck": {"command": ["CMD-SHELL", "steampipe query 'select 1'"]},
                "logConfiguration": {"logDriver": "awslogs", "options": {
                    "awslogs-group": "/ecs/" + PROJECT + "-" + component,
                    "awslogs-region": REGION, "awslogs-stream-prefix": component}},
            }],
            "executionRoleArn": f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-task-execution",
            "taskRoleArn": f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-{component}-task",
        }

    def service(self):
        c = self.meta["components"]["steampipe"]
        return {"serviceArn": c["service_arn"], "clusterArn": CLUSTER, "status": "ACTIVE",
                "taskDefinition": c["task_definition_arn"], "desiredCount": 1, "runningCount": 1,
                "pendingCount": 0, "deployments": [{
                    "id": self.deployment, "status": "PRIMARY", "rolloutState": "COMPLETED",
                    "taskDefinition": c["task_definition_arn"], "desiredCount": 1, "runningCount": 1, "pendingCount": 0,
                }]}

    def __call__(self, argv, **kwargs):
        argv = list(argv)
        self.calls.append((argv, kwargs))
        if argv == ["git", "rev-parse", "HEAD"]:
            return self.head
        if argv == ["git", "status", "--porcelain", "--untracked-files=no"]:
            return ""
        if argv[:5] == ["git", "ls-files", "--others", "--exclude-standard", "--"]:
            return self.untracked_migration_inputs
        if argv == ["make", "migrate"]:
            raise AssertionError("The CI runner must never connect to Aurora")
        if argv[:2] == ["python3", "scripts/v2/agentcore/provision.py"]:
            assert "--config" in argv and "--image" in argv
            assert Path(argv[argv.index("--config") + 1]).is_file()
            self.artifact = argv[argv.index("--image") + 1]
            self.version = "2"
            self.runtime_provisioned = True
            return SENSITIVE
        assert argv[0] == "aws", "No Terraform or shell discovery is allowed"
        assert argv[argv.index("--region") + 1] == REGION
        service, action = argv[1:3]
        if "--cli-input-json" in argv:
            params = json.loads(argv[argv.index("--cli-input-json") + 1])
            if (service, action) == ("ecs", "describe-tasks") and params.get("tasks") == [MIGRATION_TASK]:
                return json.dumps({"tasks": [self.migration_task] if self.migration_task else [], "failures": []})
            if (service, action) == ("ecs", "deregister-task-definition"):
                return json.dumps({"taskDefinition": {"taskDefinitionArn": params["taskDefinition"]}})
        if (service, action) == ("sts", "get-caller-identity"):
            result = {"Account": self.account, "Arn": f"arn:aws:sts::{self.account}:assumed-role/{PROJECT}-ci-runtime/test"}
        elif service == "ecr":
            name = argv[argv.index("--repository-name") + 1]
            component = name.removeprefix(PROJECT + "-")
            if action == "batch-get-image":
                reference = argv[argv.index("--image-ids") + 1]
                key, value = reference.split("=", 1)
                image_digest = self.tags[component].get(value) if key == "imageTag" else value
                raw = self.manifests.get(image_digest)
                result = {"images": []} if not raw else {"images": [{
                    "registryId": ACCOUNT, "repositoryName": name,
                    "imageId": {"imageDigest": image_digest, **({key: value})},
                    "imageManifest": raw, "imageManifestMediaType": json.loads(raw)["mediaType"],
                }]}
            elif action == "put-image":
                raw = argv[argv.index("--image-manifest") + 1]
                value = "sha256:" + hashlib.sha256(raw.encode()).hexdigest()
                self.tags[component][argv[argv.index("--image-tag") + 1]] = value
                result = {"image": {"imageId": {"imageDigest": value}}}
            else:
                raise AssertionError(action)
        elif service == "ssm":
            name = argv[argv.index("--name") + 1]
            values = {"runtime_arn": RUNTIME_ARN, "memory_id": "awsops_v2_memory-ABC",
                      "interpreter_id": "awsops_v2_code_interpreter-ABC"}
            if not self.runtime_provisioned:
                values["runtime_arn"] = "PENDING"
            result = {"Parameter": {"Name": name, "Type": "String", "Value": values[name.split("/")[-1]]}}
        elif (service, action) == ("rds", "describe-db-clusters"):
            known = metadata()["migration"]
            result = {"DBClusters": [{
                "DBClusterArn": f"arn:aws:rds:{REGION}:{ACCOUNT}:cluster:{PROJECT}-aurora",
                "DBClusterIdentifier": PROJECT + "-aurora", "Endpoint": known["aurora_endpoint"],
                "DatabaseName": "awsops", "Status": "available",
                "MasterUserSecret": {"SecretArn": known["aurora_secret_arn"], "SecretStatus": "active"},
            }]}
        elif service == "bedrock-agentcore-control":
            if action == "get-agent-runtime":
                result = {"agentRuntimeArn": RUNTIME_ARN, "agentRuntimeId": RUNTIME_ID,
                          "agentRuntimeName": "awsops_v2_agent", "agentRuntimeVersion": self.version,
                          "roleArn": self.meta["components"]["agentcore"]["provision"]["role_arn"],
                          "agentRuntimeArtifact": {"containerConfiguration": {"containerUri": self.artifact}},
                          "networkConfiguration": self.current_network,
                          "environmentVariables": {"CLICKHOUSE_OFFICIAL_MCP": "false",
                                                   "ANTHROPIC_AGENT_LOOP_ENABLED": self.current_loop},
                          "status": self.agent_status}
            elif action == "get-agent-runtime-endpoint":
                result = {"agentRuntimeArn": RUNTIME_ARN, "name": "DEFAULT", "status": "READY",
                          "liveVersion": self.endpoint_version or self.version}
            else:
                raise AssertionError(action)
        elif service == "ecs":
            if action == "describe-task-definition":
                ref = argv[argv.index("--task-definition") + 1]
                component = "steampipe" if "steampipe" in ref else "worker"
                result = {"taskDefinition": self.definition(component)}
                if self.family_moved and ref == PROJECT + "-worker":
                    result["taskDefinition"]["taskDefinitionArn"] += "9"
            elif action == "describe-services":
                result = {"services": [self.service()], "failures": []}
            elif action == "update-service":
                assert "--force-new-deployment" in argv and "--task-definition" not in argv
                self.deployment = "ecs-svc/2222222222222222222"
                result = {"service": self.service()}
                if self.roll_back:
                    self.deployment = "ecs-svc/1111111111111111111"
            elif action == "run-task":
                params = json.loads(argv[argv.index("--cli-input-json") + 1])
                command = params["overrides"]["containerOverrides"][0]["command"]
                assert command[:3] == ["python", "fargate_worker.py", "--ci-probe"] and len(command) == 4
                self.task = {
                    "taskArn": TASK, "clusterArn": CLUSTER, "taskDefinitionArn": params["taskDefinition"],
                    "startedBy": params["startedBy"], "group": params["group"], "tags": params["tags"],
                    "lastStatus": "STOPPED", "desiredStatus": "STOPPED",
                    "containers": [{"name": "worker", "image": self.meta["components"]["worker"]["image"],
                                    "imageDigest": DIGEST, "lastStatus": "STOPPED",
                                    "exitCode": 0 if self.probe_ok else 1}],
                }
                self.nonce = command[3]
                result = {"tasks": [copy.deepcopy(self.task)], "failures": []}
            elif action == "list-tasks":
                result = {"taskArns": [TASK]}
            elif action == "describe-tasks":
                if self.task_responses:
                    response = self.task_responses.pop(0)
                    if isinstance(response, Exception):
                        raise response
                    return json.dumps(response)
                task = self.task or {
                    "taskArn": TASK, "clusterArn": CLUSTER,
                    "taskDefinitionArn": self.meta["components"]["steampipe"]["task_definition_arn"],
                    "startedBy": self.deployment, "lastStatus": "RUNNING", "desiredStatus": "RUNNING",
                    "healthStatus": "HEALTHY",
                    "containers": [{"name": "steampipe", "lastStatus": "RUNNING", "healthStatus": "HEALTHY",
                                    "imageDigest": self.tags["steampipe"]["steampipe-latest"]}],
                }
                result = {"tasks": [copy.deepcopy(task)], "failures": []}
            elif action == "stop-task":
                self.task["lastStatus"] = "STOPPED"
                result = {"task": self.task}
            else:
                raise AssertionError(action)
        elif (service, action) == ("stepfunctions", "describe-state-machine"):
            c = self.meta["components"]["worker"]
            network = c["network"]["awsvpcConfiguration"]
            result = {"stateMachineArn": c["state_machine_arn"], "status": "ACTIVE",
                      "definition": json.dumps({"States": {"RunFargate": {
                          "Resource": "arn:aws:states:::ecs:runTask.sync",
                          "Parameters": {"Cluster": CLUSTER, "TaskDefinition": PROJECT + "-worker",
                                         "NetworkConfiguration": {"AwsvpcConfiguration": {
                                             "Subnets": network["subnets"], "SecurityGroups": network["securityGroups"],
                                             "AssignPublicIp": "DISABLED"}}}}}})}
        elif (service, action) == ("logs", "get-log-events"):
            proof = {"mode": "ci_runtime_probe", "nonce": self.nonce if self.probe_log_ok else "wrong",
                     "status": "ok", "checks": {"startup": True, "database": True, "schema": True}}
            result = {"events": [{"message": json.dumps(proof)}]}
        else:
            raise AssertionError((service, action))
        return json.dumps(result)

    def writes(self):
        return [a for a, _ in self.calls if a[:2] == ["make", "migrate"] or a[0] == "python3"
                or a[1:3] in (["ecr", "put-image"], ["ecs", "update-service"], ["ecs", "run-task"], ["ecs", "stop-task"])]


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cli = FakeCLI()
        self.path = Path(self.temp.name)
        self.env = {
            "GITHUB_REPOSITORY": "Atom-oh/awsops", "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_RUN_ID": "12345", "GITHUB_RUN_ATTEMPT": "1",
            "CI_COMMIT_SHA": SHA, "CI_EXPECTED_ACCOUNT_ID": ACCOUNT, "CI_EXPECTED_PROJECT": PROJECT,
            "AWS_REGION": REGION, "CI_ROLE_ARN": ROLE, "CI_RUNTIME_MODE": "deploy",
            "AWSOPS_RUNTIME_METADATA_JSON": json.dumps(self.cli.meta), "RUNNER_TEMP": str(self.path),
            "AWSOPS_MIGRATION_CONFIG_JSON": json.dumps(migration_config()),
            "GITHUB_ENV": str(self.path / "github-env"), "GITHUB_OUTPUT": str(self.path / "github-output"),
        }
        patch.dict(os.environ, self.env, clear=True).start()
        patch.object(runtime, "command", side_effect=self.cli).start()
        patch.object(migration, "command", side_effect=self.cli).start()
        self.addCleanup(patch.stopall)
        self.clock = [0]
        patch.object(runtime.time, "monotonic", side_effect=lambda: self.clock[0]).start()
        patch.object(runtime.time, "sleep", side_effect=lambda s: self.clock.__setitem__(0, self.clock[0] + s)).start()
        self.smoke_ok = True
        client = Mock()
        client.invoke_agent_runtime.side_effect = self.invoke_agent
        patch.object(runtime.boto3, "client", return_value=client).start()

    def invoke_agent(self, **params):
        payload = json.loads(params["payload"])
        body = {"schemaVersion": 1, "mode": "deployment_readiness", "nonce": payload["nonce"],
                "accountId": ACCOUNT, "status": "ready" if self.smoke_ok else "not_ready",
                "reason": "ok", "checks": {k: self.smoke_ok for k in runtime.AGENT_CHECKS},
                "inventory": {"count": 1, "ageMinutes": 0}}
        return {"statusCode": 200, "response": io.BytesIO(("data: " + json.dumps(body) + "\n\n").encode())}

    def call(self, step, component="worker", *extra, ok=True):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            rc = runtime.main(["--component", component, step, *extra])
        text = stdout.getvalue() + stderr.getvalue()
        self.assertNotIn(SENSITIVE, text)
        self.assertEqual(rc, 0 if ok else 1, text)
        return json.loads(stdout.getvalue())

    def prepare(self, component="worker"):
        os.environ["AWSOPS_RUNTIME_METADATA_JSON"] = json.dumps(self.cli.meta)
        self.call("prepare", component)
        for line in (self.path / "github-env").read_text().splitlines():
            key, value = line.split("=", 1)
            os.environ[key] = value
        self.call("preflight", component)

    def build(self, component="worker"):
        self.prepare(component)
        self.call("record-build", component, "--digest", DIGEST)

    def state(self):
        return json.loads(Path(os.environ["CI_RUNTIME_MANIFEST"]).read_text())

    def receipt(self, *, mode="apply", status="succeeded", digest=MIGRATION_DIGEST):
        c = {"commit": SHA, "account": ACCOUNT, "project": PROJECT, "region": REGION}
        meta = self.cli.meta["migration"]
        database = {"version": 1, **c, "database": "awsops", "endpoint": meta["aurora_endpoint"],
                    "secret_arn": meta["aurora_secret_arn"], "sql_reader_secret_arn": meta["agent_sql_reader_secret_arn"]}
        nonce = "c" * 32
        definition = ECS + f"task-definition/{PROJECT}-ci-migration:8"
        record = {"version": 1, "context": c, "config": migration_config(), "database": database,
                  "digest": digest, "mode": mode, "nonce": nonce, "definition": definition,
                  "task": MIGRATION_TASK, "status": status,
                  "proof": {"type": "awsops-migration", "version": 1, "commit": SHA,
                            "mode": mode, "nonce": nonce, "status": status}}
        file = Path(os.environ["CI_MIGRATION_RECEIPT"])
        file.write_text(json.dumps(record))
        file.chmod(0o600)
        self.cli.migration_task = {
            "taskArn": MIGRATION_TASK, "clusterArn": CLUSTER, "taskDefinitionArn": definition,
            "startedBy": nonce, "launchType": "FARGATE", "lastStatus": "STOPPED",
            "stopCode": "EssentialContainerExited",
            "containers": [{"name": "migration", "image": repo("web") + "@" + digest,
                            "imageDigest": digest, "exitCode": 0}],
        }
        return record

    def accept_migration(self):
        self.receipt()
        self.call("migrate", "agentcore", "--digest", MIGRATION_DIGEST)

    def test_prepare_exports_only_private_metadata_and_no_backend_config(self):
        self.prepare()
        self.assertEqual(json.loads(Path(os.environ["CI_RUNTIME_METADATA_FILE"]).read_text()), self.cli.meta)
        self.assertEqual(Path(os.environ["CI_RUNTIME_METADATA_FILE"]).stat().st_mode & 0o777, 0o600)
        self.assertNotIn("CI_BACKEND_CONFIG", os.environ)
        self.assertFalse(any("terraform" in a[0] for a, _ in self.cli.calls))

    def test_real_terraform_lambda_names_allow_every_component_to_prepare(self):
        for component in runtime.COMPONENTS:
            with self.subTest(component=component):
                self.prepare(component)
                saved = json.loads(Path(os.environ["CI_AGENT_CONFIG_FILE"]).read_text())
                self.assertEqual(set(saved["lambda_arns"]), set(LAMBDA_KEYS))
                self.assertEqual(self.state()["context"]["component"], component)
                self.assertEqual(self.cli.writes(), [])

    def test_lambda_arn_must_match_its_key_and_account_region_project(self):
        valid = metadata()["components"]["agentcore"]["provision"]["lambda_arns"]["core-helpers"]
        for arn in (valid.replace(ACCOUNT, "999999999999"), valid.replace(REGION, "us-east-1"),
                    valid.replace(PROJECT, "other-project"), valid.replace("core-helpers", "network-mcp"),
                    valid + "-mcp", valid + ":1", valid + "*"):
            with self.subTest(arn=arn):
                self.cli.meta = metadata()
                self.cli.meta["components"]["agentcore"]["provision"]["lambda_arns"]["core-helpers"] = arn
                os.environ["AWSOPS_RUNTIME_METADATA_JSON"] = json.dumps(self.cli.meta)
                result = self.call("prepare", "worker", ok=False)
                self.assertEqual(result["error"], "agent_targets_invalid")
                self.assertEqual(self.cli.writes(), [])

    def test_unknown_fields_secrets_wrong_scope_and_unsafe_dispatch_fail_before_writes(self):
        for mutate in (
            lambda: self.cli.meta.update(password=SENSITIVE),
            lambda: self.cli.meta.update(account_id="999999999999"),
            lambda: self.cli.meta["components"]["worker"].update(image=repo("worker") + ":x\ninjected"),
            lambda: self.cli.meta["components"]["worker"]["network"]["awsvpcConfiguration"].update(assignPublicIp="ENABLED"),
            lambda: os.environ.update(GITHUB_REF="refs/heads/dev"),
            lambda: os.environ.update(CI_ROLE_ARN=ROLE.replace("runtime", "release")),
        ):
            with self.subTest(mutate=mutate):
                self.cli.__init__()
                os.environ.update(self.env)
                mutate()
                os.environ["AWSOPS_RUNTIME_METADATA_JSON"] = json.dumps(self.cli.meta)
                self.call("prepare", ok=False)
                self.assertEqual(self.cli.writes(), [])

    def test_check_is_read_only_and_does_not_claim_execution(self):
        os.environ["CI_RUNTIME_MODE"] = "check"
        self.prepare()
        result = self.call("check")
        self.assertEqual(result["status"], "checked")
        self.assertNotIn("release", self.state())
        self.assertEqual(self.cli.writes(), [])
        self.call("deploy", ok=False)

    def test_account_or_source_movement_rejects(self):
        self.prepare()
        self.cli.account = "999999999999"
        self.call("check", ok=False)
        self.cli.account = ACCOUNT
        self.cli.head = "b" * 40
        self.call("check", ok=False)

    def test_build_digest_must_match_commit_tag_and_manifest(self):
        self.prepare()
        self.call("record-build", "worker", "--digest", OLD_DIGEST, ok=False)
        self.assertNotIn("build", self.state())
        self.call("record-build", "worker", "--digest", DIGEST)
        self.assertEqual(self.state()["build"]["digest"], DIGEST)

    def test_worker_deploy_proves_built_image_startup_and_database_without_revision_drift(self):
        self.build()
        result = self.call("deploy")
        self.assertEqual(result["status"], "complete")
        proof = self.state()["release"]
        self.assertEqual(proof["digest"], DIGEST)
        self.assertEqual(proof["task_arn"], TASK)
        self.assertFalse(any(a[1:3] == ["ecs", "register-task-definition"] for a, _ in self.cli.calls))
        self.assertFalse(any(a[1:3] == ["ecs", "update-service"] for a, _ in self.cli.calls))

    def test_worker_publish_without_successful_execution_is_failure(self):
        self.build()
        self.cli.probe_ok = False
        self.call("deploy", ok=False)
        self.assertNotIn("release", self.state())

    def test_worker_waits_for_task_visibility_during_deploy_and_cleanup(self):
        self.build()
        missing = {"tasks": [], "failures": [{"arn": TASK, "reason": "MISSING"}]}
        self.cli.task_responses = [missing, {}, {"failures": missing["failures"]}, {"tasks": []}]
        self.assertEqual(self.call("deploy")["status"], "complete")
        self.assertEqual(self.clock[0], 20)
        self.cli.task["lastStatus"] = "RUNNING"
        self.cli.task_responses = [{"tasks": []}, missing]
        self.assertEqual(self.call("cleanup")["status"], "cleaned")
        for action in ("run-task", "stop-task"):
            self.assertEqual(sum(a[1:3] == ["ecs", action] for a, _ in self.cli.calls), 1)

    def test_missing_worker_task_times_out_without_discarding_its_receipt(self):
        self.build()
        self.cli.task_responses = [{"tasks": [], "failures": [{"arn": TASK, "reason": "MISSING"}]}] * 100
        self.assertEqual(self.call("deploy", "worker", "--timeout-seconds", "10", ok=False)["error"], "runtime_timeout")
        self.assertEqual(self.state()["probe"]["task_arn"], TASK)
        self.assertNotIn("release", self.state())
        self.assertEqual(self.call("cleanup", ok=False)["error"], "runtime_timeout")
        self.assertEqual(self.clock[0], 70)
        self.assertTrue(Path(os.environ["CI_RUNTIME_MANIFEST"]).exists())
        self.assertFalse(any(a[1:3] == ["ecs", "stop-task"] for a, _ in self.cli.calls))

    def test_worker_task_api_denials_and_malformed_failures_are_not_retried(self):
        self.build()
        self.call("deploy")
        self.cli.task["lastStatus"] = "RUNNING"
        for response in ({"tasks": None}, runtime.ReleaseError("command_failed"),
                         {"tasks": [], "failures": [{"arn": TASK, "reason": "ACCESS_DENIED"}]},
                         {"tasks": [], "failures": [{"arn": TASK + "other", "reason": "MISSING"}]}):
            with self.subTest(response=response):
                self.cli.task_responses = [response]
                self.call("cleanup", ok=False)
                self.assertEqual(self.clock[0], 0)
                self.assertFalse(any(a[1:3] == ["ecs", "stop-task"] for a, _ in self.cli.calls))

    def test_unrelated_log_nonce_cannot_prove_worker_success(self):
        self.build()
        self.cli.probe_log_ok = False
        self.call("deploy", "worker", "--timeout-seconds", "1", ok=False)
        self.assertNotIn("release", self.state())

    def test_pinned_worker_requires_reviewed_pin_match_and_never_updates_task_definition(self):
        self.cli.meta["components"]["worker"]["image"] = repo("worker") + "@" + OLD_DIGEST
        self.build()
        result = self.call("deploy", ok=False)
        self.assertEqual(result["error"], "image_pin_requires_reviewed_apply")
        self.assertEqual(self.cli.writes(), [])

    def test_release_never_retags_another_commit_source_tag(self):
        tag = "worker-" + "b" * 40
        self.cli.meta["components"]["worker"]["image"] = repo("worker") + ":" + tag
        self.cli.tags["worker"][tag] = OLD_DIGEST
        self.build()
        self.call("deploy", ok=False)
        self.assertEqual(self.cli.tags["worker"][tag], OLD_DIGEST)
        self.assertEqual(self.cli.writes(), [])

    def test_worker_family_movement_blocks_promotion(self):
        self.build()
        self.cli.family_moved = True
        self.call("deploy", ok=False)
        self.assertEqual(self.cli.writes(), [])

    def test_worker_cleanup_never_stops_foreign_or_replaced_tasks(self):
        self.build()
        self.call("deploy")
        self.cli.task["lastStatus"] = "RUNNING"
        self.cli.task["tags"] = []
        self.cli.task_responses = [{"tasks": [], "failures": [{"arn": TASK, "reason": "MISSING"}]}]
        self.assertEqual(self.call("cleanup", ok=False)["error"], "probe_owner_mismatch")
        self.assertFalse(any(a[1:3] == ["ecs", "stop-task"] for a, _ in self.cli.calls))

    def test_worker_cleanup_stops_only_owned_probe(self):
        self.build()
        self.call("deploy")
        self.cli.task["lastStatus"] = "RUNNING"
        self.call("cleanup")
        stops = [a for a, _ in self.cli.calls if a[1:3] == ["ecs", "stop-task"]]
        self.assertEqual(len(stops), 1)
        self.assertEqual(stops[0][stops[0].index("--task") + 1], TASK)

    def test_steampipe_rolls_existing_definition_and_checks_exact_primary_image(self):
        self.build("steampipe")
        self.assertEqual(self.call("deploy", "steampipe")["status"], "complete")
        updates = [a for a, _ in self.cli.calls if a[1:3] == ["ecs", "update-service"]]
        self.assertEqual(len(updates), 1)
        self.assertNotIn("--task-definition", updates[0])

    def test_steampipe_rollback_is_failure(self):
        self.build("steampipe")
        self.cli.roll_back = True
        self.call("deploy", "steampipe", ok=False)
        self.assertNotIn("release", self.state())

    def test_agentcore_requires_migrations_before_digest_pinned_provision(self):
        self.build("agentcore")
        self.call("deploy", "agentcore", ok=False)
        self.assertEqual(self.cli.writes(), [])
        self.call("migrate", "agentcore", "--digest", MIGRATION_DIGEST, ok=False)
        self.assertNotIn("migration", self.state())
        self.accept_migration()
        self.assertEqual(self.call("deploy", "agentcore")["status"], "complete")
        calls = [a for a, _ in self.cli.calls if a[0] == "python3"]
        self.assertEqual(calls[-1][calls[-1].index("--image") + 1], repo("agentcore") + "@" + DIGEST)

    def test_untracked_migration_input_blocks_agentcore_preflight(self):
        self.call("prepare", "agentcore")
        for line in (self.path / "github-env").read_text().splitlines():
            key, value = line.split("=", 1)
            os.environ[key] = value
        self.cli.untracked_migration_inputs = "terraform/v2/foundation/migrations/untracked.sql\n"
        result = self.call("preflight", "agentcore", ok=False)
        self.assertEqual(result["error"], "untracked_migration_input")
        self.assertEqual(self.cli.writes(), [])

    def test_only_applied_success_receipt_with_live_ecs_proof_is_accepted(self):
        self.build("agentcore")
        for mode, status in (("preview", "succeeded"), ("apply", "failed")):
            self.receipt(mode=mode, status=status)
            self.call("migrate", "agentcore", "--digest", MIGRATION_DIGEST, ok=False)
            self.assertNotIn("migration", self.state())
        self.receipt()
        self.cli.migration_task["containers"][0]["exitCode"] = 1
        self.call("migrate", "agentcore", "--digest", MIGRATION_DIGEST, ok=False)
        self.receipt()
        self.call("migrate", "agentcore", "--digest", DIGEST, ok=False)
        self.assertFalse(any(a == ["make", "migrate"] for a, _ in self.cli.calls))
        self.accept_migration()

    def test_runtime_cleanup_delegates_migration_cleanup_without_deregister(self):
        self.build("agentcore")
        self.accept_migration()
        self.cli.calls.clear()
        directory = Path(os.environ["CI_MIGRATION_RECEIPT"]).parent
        self.call("cleanup", "agentcore")
        descriptions = [a for a, _ in self.cli.calls if a[1:3] == ["ecs", "describe-tasks"]]
        self.assertTrue(any(MIGRATION_TASK in " ".join(a) for a in descriptions))
        self.assertFalse(any(a[1:3] == ["ecs", "deregister-task-definition"] for a, _ in self.cli.calls))
        self.assertFalse(directory.exists())

    def test_failed_shared_cleanup_preserves_private_receipt(self):
        self.build("agentcore")
        self.accept_migration()
        self.cli.migration_task["startedBy"] = "f" * 32
        receipt = Path(os.environ["CI_MIGRATION_RECEIPT"])
        self.call("cleanup", "agentcore", ok=False)
        self.assertTrue(receipt.is_file())

    def test_agentcore_rechecks_receipt_before_provisioning(self):
        self.build("agentcore")
        self.accept_migration()
        self.cli.migration_task["containers"][0]["exitCode"] = 1
        self.call("deploy", "agentcore", ok=False)
        self.assertFalse(any(a[0] == "python3" for a, _ in self.cli.calls))

    def test_agentcore_ready_without_real_positive_smoke_does_not_complete(self):
        self.build("agentcore")
        self.accept_migration()
        self.smoke_ok = False
        self.call("deploy", "agentcore", ok=False)
        self.assertNotIn("release", self.state())

    def test_agentcore_initial_provision_from_pending_parameter(self):
        self.cli.runtime_provisioned = False
        self.build("agentcore")
        self.accept_migration()
        self.assertEqual(self.call("deploy", "agentcore")["status"], "complete")

    def test_migration_endpoint_requires_independent_account_resource_match(self):
        self.cli.meta["migration"]["aurora_endpoint"] = f"{PROJECT}-aurora.cluster-other.{REGION}.rds.amazonaws.com"
        self.call("prepare", "agentcore")
        for line in (self.path / "github-env").read_text().splitlines():
            key, value = line.split("=", 1)
            os.environ[key] = value
        # Use the changed handoff, not a changed discovery fixture.
        file = Path(os.environ["CI_RUNTIME_METADATA_FILE"])
        file.write_text(json.dumps(self.cli.meta))
        self.call("preflight", "agentcore", ok=False)
        self.assertEqual(self.cli.writes(), [])

    def test_agentcore_endpoint_cannot_keep_serving_previous_version(self):
        self.build("agentcore")
        self.accept_migration()
        self.cli.endpoint_version = "1"
        self.call("deploy", "agentcore", "--timeout-seconds", "1", ok=False)
        self.assertNotIn("release", self.state())

    def test_agentcore_preserves_current_loop_flag_and_rejects_network_change(self):
        self.cli.current_loop = "true"
        self.build("agentcore")
        self.accept_migration()
        self.call("deploy", "agentcore")
        _, params = next((a, k) for a, k in self.cli.calls if a[0] == "python3")
        self.assertEqual(params["env"]["ANTHROPIC_AGENT_LOOP_ENABLED"], "true")
        self.assertEqual(params["env"]["CLICKHOUSE_OFFICIAL_MCP"], "false")

    def test_agentcore_metadata_cannot_change_runtime_network(self):
        self.cli.current_network = {"networkMode": "PUBLIC"}
        self.call("prepare", "agentcore")
        for line in (self.path / "github-env").read_text().splitlines():
            key, value = line.split("=", 1)
            os.environ[key] = value
        self.call("preflight", "agentcore", ok=False)
        self.assertEqual(self.cli.writes(), [])

    def test_agentcore_does_not_enable_readiness_or_frozen_flags(self):
        self.cli.meta["components"]["agentcore"]["provision"]["deployment_readiness_enabled"] = False
        os.environ["AWSOPS_RUNTIME_METADATA_JSON"] = json.dumps(self.cli.meta)
        self.call("prepare", "agentcore")
        for line in (self.path / "github-env").read_text().splitlines():
            key, value = line.split("=", 1)
            os.environ[key] = value
        self.call("preflight", "agentcore", ok=False)
        self.assertEqual(self.cli.writes(), [])


class WorkerProbeTests(unittest.TestCase):
    def load(self, db):
        path = Path(__file__).parent / "workers" / "fargate_worker.py"
        spec = importlib.util.spec_from_file_location("ci_worker_fixture", path)
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"db": db, "handlers": Mock()}):
            spec.loader.exec_module(module)
        return module

    def test_probe_executes_read_only_database_check_and_emits_bound_proof(self):
        conn = Mock()
        conn.run.side_effect = [None, [["awsops", "awsops_worker", True, True]]]
        db = Mock()
        db.connect.return_value = conn
        worker = self.load(db)
        output = io.StringIO()
        with patch.dict(os.environ, {"AURORA_DATABASE": "awsops", "AURORA_USER": "awsops_worker"}):
            with contextlib.redirect_stdout(output):
                self.assertEqual(worker.ci_probe("a" * 32), 0)
        proof = json.loads(output.getvalue())
        self.assertEqual(proof["nonce"], "a" * 32)
        self.assertEqual(proof["checks"], {"startup": True, "database": True, "schema": True})
        self.assertIn("read only", conn.run.call_args_list[0].args[0].lower())
        db.claim_running.assert_not_called()
        db.finish_job.assert_not_called()
        conn.close.assert_called_once()

    def test_probe_failure_is_nonzero_and_never_logs_driver_details(self):
        db = Mock()
        db.connect.side_effect = RuntimeError(SENSITIVE)
        worker = self.load(db)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(worker.ci_probe("b" * 32), 1)
        self.assertNotIn(SENSITIVE, output.getvalue())
        self.assertEqual(json.loads(output.getvalue())["status"], "failed")


class ProvisionerTests(unittest.TestCase):
    def load(self):
        directory = Path(__file__).parent / "agentcore"
        spec = importlib.util.spec_from_file_location("ci_provision_fixture", directory / "provision.py")
        module = importlib.util.module_from_spec(spec)
        with patch.object(sys, "path", [str(directory), *sys.path]):
            spec.loader.exec_module(module)
        return module

    def test_operator_runtime_create_uses_pinned_image_and_project_request_tag(self):
        provision = self.load()
        provision.IMAGE_URI = repo("agentcore") + "@" + DIGEST
        ctrl = Mock()
        ctrl.list_agent_runtimes.return_value = {"agentRuntimes": []}
        ctrl.create_agent_runtime.return_value = {"agentRuntimeArn": RUNTIME_ARN, "agentRuntimeId": RUNTIME_ID}
        ctrl.get_agent_runtime.return_value = {"status": "READY"}
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.ensure_runtime(ctrl, metadata()["components"]["agentcore"]["provision"], {}), RUNTIME_ARN)
        request = ctrl.create_agent_runtime.call_args.kwargs
        self.assertEqual(request["agentRuntimeArtifact"]["containerConfiguration"]["containerUri"], provision.IMAGE_URI)
        self.assertEqual(request["tags"], {"awsops:project": PROJECT})

    def test_private_agent_config_load_never_reads_terraform_or_accepts_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "agent.json"
            config = metadata()["components"]["agentcore"]["provision"]
            file.write_text(json.dumps(config))
            file.chmod(0o600)
            with patch.object(runtime, "command", side_effect=AssertionError("No CLI needed")):
                self.assertEqual(runtime.load_agent_config(file), config)
                config["password"] = SENSITIVE
                file.write_text(json.dumps(config))
                with self.assertRaises(runtime.ReleaseError):
                    runtime.load_agent_config(file)


class AgentProtocolTests(unittest.TestCase):
    def proof(self):
        return {"schemaVersion": 1, "mode": "deployment_readiness", "nonce": "a" * 32,
                "accountId": ACCOUNT, "status": "ready", "reason": "ok",
                "checks": {k: True for k in runtime.AGENT_CHECKS},
                "inventory": {"count": 1, "ageMinutes": 2}}

    def test_sse_keepalive_and_done_are_accepted(self):
        raw = (": keepalive\nevent: readiness\ndata: " + json.dumps(self.proof()) + "\n\ndata: [DONE]\n\n").encode()
        self.assertEqual(runtime.parsed_smoke(raw, "a" * 32, ACCOUNT), self.proof()["checks"])

    def test_missing_or_unknown_fields_and_missing_inventory_fail_closed(self):
        for mutate in (lambda p: p.pop("inventory"), lambda p: p.update(extra="unexpected"),
                       lambda p: p["inventory"].update(count=None),
                       lambda p: p["checks"].update(model=False)):
            proof = self.proof()
            mutate(proof)
            with self.subTest(proof=proof), self.assertRaises(runtime.ReleaseError):
                runtime.parsed_smoke(json.dumps(proof).encode(), "a" * 32, ACCOUNT)


class WorkflowTests(unittest.TestCase):
    def test_runtime_workflow_has_manual_check_default_and_separate_production_role(self):
        file = runtime.ROOT / ".github/workflows/deploy-runtime.yml"
        self.assertTrue(file.is_file(), "Runtime workflow is required")
        document = yaml.safe_load(file.read_text())
        trigger = document.get("on", document.get(True))
        self.assertEqual(set(trigger), {"workflow_dispatch"})
        inputs = trigger["workflow_dispatch"]["inputs"]
        self.assertEqual(inputs["mode"]["default"], "check")
        self.assertEqual(set(inputs["component"]["options"]), set(runtime.COMPONENTS))
        production = [j for j in document["jobs"].values() if j.get("environment") == "production"]
        self.assertEqual(len(production), 1)
        job = production[0]
        self.assertEqual(job["runs-on"], "ubuntu-24.04-arm")
        self.assertEqual(job["permissions"]["id-token"], "write")
        credentials = [s for s in job["steps"] if s.get("uses", "").startswith("aws-actions/configure-aws-credentials@")]
        self.assertTrue(credentials)
        self.assertTrue(all(s["with"]["role-to-assume"] == "${{ vars.AWSOPS_RUNTIME_ROLE_ARN }}" for s in credentials))
        builds = [s for s in job["steps"] if s.get("uses", "").startswith("docker/build-push-action@")]
        self.assertEqual(len(builds), 2)
        for build in builds:
            self.assertEqual(build["with"]["platforms"], "linux/arm64")
            self.assertIn("inputs.mode == 'deploy'", build["if"])
        migration_build = next(s for s in builds if s["id"] == "migration_image")
        archive = next(s for s in job["steps"] if s.get("id") == "migration_context")
        self.assertIn("ci_origin_migration.py prepare-build", archive["run"])
        self.assertLess(job["steps"].index(archive), job["steps"].index(migration_build))
        self.assertEqual(migration_build["with"]["context"], "${{ steps.migration_context.outputs.context }}")
        self.assertEqual(migration_build["with"]["file"],
                         "${{ steps.migration_context.outputs.context }}/scripts/v2/ci/Dockerfile.origin-migration")
        self.assertIs(migration_build["with"]["provenance"], False)
        self.assertIs(migration_build["with"]["sbom"], False)
        self.assertEqual(migration_build["with"]["build-args"], "SOURCE_COMMIT=${{ github.sha }}")
        commands = [s.get("run", "") for s in job["steps"]]
        self.assertFalse(any("make migrate" in command for command in commands))
        self.assertTrue(any("ci_origin_migration.py check" in command for command in commands))
        self.assertTrue(any("ci_origin_migration.py run" in command and "--mode apply" in command for command in commands))
        self.assertFalse(any(s.get("uses", "").startswith("hashicorp/setup-terraform@") for s in job["steps"]))
        self.assertEqual(document["concurrency"]["cancel-in-progress"], False)



if __name__ == "__main__":
    unittest.main()
