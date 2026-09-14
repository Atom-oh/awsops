"""Offline contract tests: real controller, fake git/AWS command boundary only.

Run this file in its own process; no credentials or running infrastructure needed.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import subprocess
from types import SimpleNamespace

import pytest

import ci_origin_migration as subject


ACCOUNT = "123456789012"
REGION = "ap-northeast-2"
PROJECT = "awsops-v2"
COMMIT = "a" * 40
NONCE = "b" * 32
PREFIX = f"arn:aws:ecs:{REGION}:{ACCOUNT}:"
CLUSTER = PREFIX + "cluster/" + PROJECT
DEFINITION = PREFIX + f"task-definition/{PROJECT}-ci-migration:7"
TASK = PREFIX + f"task/{PROJECT}/" + "c" * 32
REPO = f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/{PROJECT}-web"
SECRET = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:rds!cluster-example-AbCd12"
READER = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:ops/{PROJECT}/agent/sql-reader-EfGh34"
CONFIG = {
    "version": 1, "account": ACCOUNT, "region": REGION, "project": PROJECT,
    "subnets": ["subnet-0123456789abcdef0"],
    "security_group": "sg-0123456789abcdef0",
    "master_secret_arn": SECRET, "sql_reader_secret_arn": READER,
    "task_role_arn": f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-ci-migration-task",
    "execution_role_arn": f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-ci-migration-execution",
    "log_group": f"/ecs/{PROJECT}-ci-migration",
}
DATABASE = {
    "DBClusterArn": f"arn:aws:rds:{REGION}:{ACCOUNT}:cluster:{PROJECT}-aurora",
    "DBClusterIdentifier": PROJECT + "-aurora",
    "DatabaseName": "awsops", "Status": "available",
    "MasterUserSecret": {"SecretArn": SECRET, "SecretStatus": "active"},
    "Endpoint": f"{PROJECT}-aurora.cluster-example.{REGION}.rds.amazonaws.com",
}


class FakeCommands:
    """Reject unexpected commands; capture actual CLI inputs, never call AWS."""

    def __init__(self, receipt):
        self.receipt = receipt
        self.calls = []
        self.hooks = {}
        self.clock = 0
        self.stopped = False
        self.source = COMMIT
        self.dirty = ""
        self.untracked = ""
        self.database = copy.deepcopy(DATABASE)
        self.manifest = json.dumps({
            "schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {"digest": "sha256:" + "d" * 64}, "layers": [],
        })
        self.digest = "sha256:" + hashlib.sha256(self.manifest.encode()).hexdigest()
        self.mode = "apply"
        self.task_changes = {}
        self.container_changes = {}
        self.sidecars = []
        self.definition = None
        self.missing_reads = 0

    def sleep(self, seconds):
        self.clock += seconds

    def task(self, status="STOPPED"):
        return {
            "taskArn": TASK, "clusterArn": CLUSTER, "taskDefinitionArn": DEFINITION,
            "startedBy": NONCE, "launchType": "FARGATE", "lastStatus": status,
            "stopCode": "EssentialContainerExited",
            "containers": [{"name": "migration", "exitCode": 0,
                            "image": REPO + "@" + self.digest, "imageDigest": self.digest,
                            **self.container_changes}, *copy.deepcopy(self.sidecars)],
            **self.task_changes,
        }

    def proof(self):
        return {"type": "awsops-migration", "version": 1, "commit": COMMIT,
                "mode": self.mode, "nonce": NONCE, "status": "succeeded"}

    def __call__(self, argv, *, timeout=60, **kwargs):
        if argv == ["git", "rev-parse", "HEAD"]:
            return self.source
        if argv == ["git", "status", "--porcelain", "--untracked-files=no"]:
            return self.dirty
        if argv[:5] == ["git", "ls-files", "--others", "--exclude-standard", "--"]:
            assert tuple(argv[5:]) == subject.BUILD_INPUTS
            return self.untracked
        assert argv[0] == "aws", f"Unexpected command: {argv}"
        assert 0 < timeout <= 60
        assert argv[argv.index("--region") + 1] == REGION
        assert "--no-paginate" in argv
        operation = tuple(argv[1:3])
        params = json.loads(argv[argv.index("--cli-input-json") + 1])
        self.calls.append((operation, params))
        if operation in self.hooks:
            return json.dumps(self.hooks[operation](params))
        return json.dumps(self.respond(operation, params))

    def respond(self, operation, params):
        if operation == ("sts", "get-caller-identity"):
            return {"Account": ACCOUNT,
                    "Arn": f"arn:aws:sts::{ACCOUNT}:assumed-role/{PROJECT}-ci-release/test"}
        if operation == ("rds", "describe-db-clusters"):
            assert params == {"DBClusterIdentifier": PROJECT + "-aurora"}
            return {"DBClusters": [self.database]}
        if operation == ("ecr", "batch-get-image"):
            assert params == {"registryId": ACCOUNT, "repositoryName": PROJECT + "-web",
                              "imageIds": [{"imageTag": "migration-" + COMMIT}]}
            return {"images": [{"registryId": ACCOUNT, "repositoryName": PROJECT + "-web",
                                "imageId": {"imageTag": "migration-" + COMMIT,
                                            "imageDigest": self.digest},
                                "imageManifest": self.manifest}], "failures": []}
        if operation == ("ecs", "register-task-definition"):
            values = {e["name"]: e["value"] for e in params["containerDefinitions"][0]["environment"]}
            self.mode = values["CI_MIGRATION_MODE"]
            self.definition = {"taskDefinitionArn": DEFINITION, **copy.deepcopy(params)}
            return {"taskDefinition": self.definition}
        if operation == ("ecs", "describe-task-definition"):
            assert params == {"taskDefinition": DEFINITION}
            return {"taskDefinition": copy.deepcopy(self.definition)}
        if operation == ("ecs", "run-task"):
            # The durable journal must precede any launch, including a lost response.
            assert self.receipt.is_file()
            assert json.loads(self.receipt.read_text())["status"] == "launching"
            return {"tasks": [self.task("PENDING")], "failures": []}
        if operation == ("ecs", "describe-tasks"):
            assert params["cluster"] == CLUSTER
            if self.missing_reads:
                self.missing_reads -= 1
                return {"tasks": [], "failures": [{"arn": TASK, "reason": "MISSING"}]}
            return {"tasks": [self.task()], "failures": []}
        if operation == ("ecs", "list-tasks"):
            assert params == {"cluster": CLUSTER, "startedBy": NONCE}
            return {"taskArns": [TASK]}
        if operation == ("ecs", "stop-task"):
            assert params["cluster"] == CLUSTER and params["task"] == TASK
            self.stopped = True
            return {"task": self.task()}
        if operation == ("logs", "get-log-events"):
            assert params["logGroupName"] == CONFIG["log_group"]
            assert params["logStreamName"] == "migration/migration/" + "c" * 32
            return {"events": [{"message": "irrelevant non-JSON notice"},
                               {"message": json.dumps(self.proof())}]}
        raise AssertionError(f"Unexpected AWS operation: {operation}")

    def operations(self):
        return [operation for operation, _ in self.calls]


@pytest.fixture
def rig(tmp_path, monkeypatch):
    # pytest's temp root must be outside this checkout, just like RUNNER_TEMP.
    receipt = tmp_path / "migration.json"
    assert not receipt.is_relative_to(subject.ROOT)
    for key in list(os.environ):
        if key.startswith("AWS_ENDPOINT_URL"):
            monkeypatch.delenv(key)
    for key, value in {
        "CI_COMMIT_SHA": COMMIT, "CI_EXPECTED_ACCOUNT_ID": ACCOUNT,
        "CI_EXPECTED_PROJECT": PROJECT, "AWS_REGION": REGION,
        "CI_ROLE_ARN": f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-ci-release",
        "AWSOPS_MIGRATION_CONFIG_JSON": json.dumps(CONFIG),
        "CI_MIGRATION_RECEIPT": str(receipt),
    }.items():
        monkeypatch.setenv(key, value)
    commands = FakeCommands(receipt)
    monkeypatch.setattr(subject, "command", commands)
    monkeypatch.setattr(subject.uuid, "uuid4", lambda: SimpleNamespace(hex=NONCE))
    monkeypatch.setattr(subject.time, "monotonic", lambda: commands.clock)
    monkeypatch.setattr(subject.time, "sleep", commands.sleep)
    return commands


@pytest.mark.parametrize("mode", ["preview", "apply"])
def test_success_binds_source_private_target_digest_nonce_and_runtime(rig, mode):
    migration = subject.Migration()
    record = migration.run(rig.digest, mode, poll=1)
    assert record["status"] == "succeeded"
    assert record["proof"] == rig.proof()
    assert rig.receipt.stat().st_mode & 0o777 == 0o600
    definition = next(p for op, p in rig.calls if op == ("ecs", "register-task-definition"))
    assert definition["runtimePlatform"] == {"cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX"}
    assert definition["taskRoleArn"] == CONFIG["task_role_arn"]
    assert definition["executionRoleArn"] == CONFIG["execution_role_arn"]
    container = definition["containerDefinitions"][0]
    assert container["user"] == "1000:1000"
    assert container["image"] == REPO + "@" + rig.digest
    env = {item["name"]: item["value"] for item in container["environment"]}
    assert set(env) == {"AWS_REGION", "CI_COMMIT_SHA", "CI_EXPECTED_ACCOUNT_ID",
                        "CI_EXPECTED_PROJECT", "CI_MIGRATION_MODE", "CI_MIGRATION_NONCE",
                        "CI_MIGRATION_METADATA"}
    assert json.loads(env["CI_MIGRATION_METADATA"]) == record["database"]
    run = next(p for op, p in rig.calls if op == ("ecs", "run-task"))
    assert run["taskDefinition"] == DEFINITION and run["count"] == 1
    assert run["clientToken"] == run["startedBy"] == NONCE
    assert run["enableExecuteCommand"] is False
    assert run["tags"] == [{"key": "Project", "value": PROJECT},
                           {"key": "Purpose", "value": "ci-migration"}]
    assert run["networkConfiguration"]["awsvpcConfiguration"] == {
        "subnets": CONFIG["subnets"], "securityGroups": [CONFIG["security_group"]],
        "assignPublicIp": "DISABLED",
    }
    assert "overrides" not in run
    assert not any(service == "secretsmanager" for service, _ in rig.operations())


def guardduty_sidecar(rig, exit_code=143):
    rig.task_changes["startedAt"] = "2026-09-14T15:17:26.349000+00:00"
    return {
        "name": "aws-guardduty-agent-dpSB4", "runtimeId": "c" * 32 + "-1459054608",
        "lastStatus": "STOPPED", "healthStatus": "UNKNOWN", "exitCode": exit_code,
    }


@pytest.mark.parametrize("mode", ["preview", "apply"])
@pytest.mark.parametrize("exit_code", [0, 143])
@pytest.mark.parametrize("image_form", ["absent", "tag", "digest"])
def test_aws_injected_guardduty_is_verified_in_run_and_receipt(rig, mode, exit_code, image_form):
    agent = guardduty_sidecar(rig, exit_code)
    repo = f"914738172881.dkr.ecr.{REGION}.amazonaws.com/aws-guardduty-agent-fargate"
    if image_form != "absent":
        agent["imageDigest"] = "sha256:" + "e" * 64
        agent["image"] = repo + (":v1.17.1-Fg_arm64" if image_form == "tag" else "@" + agent["imageDigest"])
    rig.sidecars = [agent]
    # AWS's captured response lists the injected agent before the application.
    rig.hooks[("ecs", "describe-tasks")] = lambda _: {
        "tasks": [{**rig.task(), "containers": list(reversed(rig.task()["containers"]))}], "failures": []}
    migration = subject.Migration()
    record = migration.run(rig.digest, mode, poll=1)
    assert migration.verify_receipt(record["database"], mode) == record
    assert rig.operations().count(("ecs", "describe-task-definition")) == 2
    assert len(rig.definition["containerDefinitions"]) == 1


@pytest.mark.parametrize("phase", ["run", "verify"])
@pytest.mark.parametrize("field,value", [
    ("exitCode", None), ("exitCode", False), ("exitCode", 1), ("exitCode", 137),
    ("exitCode", 139), ("exitCode", 255), ("runtimeId", None), ("runtimeId", ""),
    ("lastStatus", "RUNNING"), ("healthStatus", "UNHEALTHY"),
    ("reason", "CannotPullContainerError: ECR 403 PRIVATE_SECURITY_ERROR"),
    ("reason", "OutOfMemoryError"), ("image", "attacker.example/agent:latest"),
    ("image", f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/aws-guardduty-agent-fargate:latest"),
    ("image", "914738172881.dkr.ecr.us-east-1.amazonaws.com/aws-guardduty-agent-fargate:latest"),
    ("image", f"914738172881.dkr.ecr.{REGION}.amazonaws.com/unrelated:latest"),
    ("imageDigest", ""), ("imageDigest", "sha256:bad"),
])
def test_failed_or_untrusted_guardduty_never_proves_success(rig, phase, field, value):
    agent = guardduty_sidecar(rig)
    rig.sidecars = [agent]
    migration = subject.Migration()
    if phase == "verify":
        record = migration.run(rig.digest, "apply", poll=1)
    agent[field] = value
    with pytest.raises(subject.ReleaseError):
        if phase == "run":
            migration.run(rig.digest, "apply", poll=1)
        else:
            migration.verify_receipt(record["database"])
    if phase == "run":
        assert json.loads(rig.receipt.read_text())["status"] != "succeeded"


@pytest.mark.parametrize("extra", ["unknown", "duplicate-agent", "duplicate-migration"])
def test_unrecognized_or_duplicate_containers_are_not_ignored(rig, extra):
    rig.sidecars = [guardduty_sidecar(rig)]
    rig.sidecars.append({"name": "other"} if extra == "unknown" else
                        copy.deepcopy(rig.sidecars[0] if extra == "duplicate-agent" else rig.task()["containers"][0]))
    with pytest.raises(subject.ReleaseError):
        subject.Migration().run(rig.digest, "apply")


@pytest.mark.parametrize("change", [
    lambda d: d.update(taskDefinitionArn=DEFINITION + "0"),
    lambda d: d.update(taskRoleArn=CONFIG["execution_role_arn"]),
    lambda d: d.update(executionRoleArn=CONFIG["task_role_arn"]),
    lambda d: d.update(networkMode="host"),
    lambda d: d.update(runtimePlatform={"cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX"}),
    lambda d: d["containerDefinitions"].append({"name": "aws-guardduty-agent-dpSB4", "image": "attacker"}),
    lambda d: d["containerDefinitions"][0].update(name="other"),
    lambda d: d["containerDefinitions"][0].update(image="attacker"),
    lambda d: d["containerDefinitions"][0].update(essential=False),
    lambda d: d["containerDefinitions"][0].update(command=["node", "-e", "fake proof"]),
])
def test_guardduty_requires_original_single_container_definition(rig, change):
    rig.sidecars = [guardduty_sidecar(rig)]
    def definition(_):
        result = copy.deepcopy(rig.definition)
        change(result)
        return {"taskDefinition": result}
    rig.hooks[("ecs", "describe-task-definition")] = definition
    with pytest.raises(subject.ReleaseError):
        subject.Migration().run(rig.digest, "apply", poll=1)


def test_guardduty_cannot_bypass_task_role_overrides(rig):
    rig.sidecars = [guardduty_sidecar(rig)]
    rig.task_changes["overrides"] = {"taskRoleArn": f"arn:aws:iam::{ACCOUNT}:role/Administrator"}
    with pytest.raises(subject.ReleaseError):
        subject.Migration().run(rig.digest, "apply", poll=1)


@pytest.mark.parametrize("started", [None, 0, -1, False, "not-a-time", "2026-09-14T15:17:26"])
def test_guardduty_requires_evidence_of_a_started_task(rig, started):
    rig.sidecars = [guardduty_sidecar(rig)]
    rig.task_changes["startedAt"] = started
    with pytest.raises(subject.ReleaseError, match="migration_guardduty_agent_failed"):
        subject.Migration().run(rig.digest, "apply", poll=1)


def test_one_unknown_extra_container_is_not_a_guardduty_exception(rig):
    agent = guardduty_sidecar(rig)
    agent["name"] = "customer-monitor"
    rig.sidecars = [agent]
    with pytest.raises(subject.ReleaseError, match="migration_unexpected_container"):
        subject.Migration().run(rig.digest, "apply", poll=1)


def test_guardduty_definition_is_rechecked_when_consuming_receipt(rig):
    rig.sidecars = [guardduty_sidecar(rig)]
    migration = subject.Migration()
    record = migration.run(rig.digest, "apply", poll=1)
    rig.definition["executionRoleArn"] = CONFIG["task_role_arn"]
    with pytest.raises(subject.ReleaseError, match="migration_guardduty_definition_mismatch"):
        migration.verify_receipt(record["database"])


def test_guardduty_digest_must_agree_with_pinned_image_when_both_are_exposed(rig):
    agent = guardduty_sidecar(rig)
    agent.update(image=f"914738172881.dkr.ecr.{REGION}.amazonaws.com/aws-guardduty-agent-fargate@sha256:" + "e" * 64,
                 imageDigest="sha256:" + "f" * 64)
    rig.sidecars = [agent]
    with pytest.raises(subject.ReleaseError, match="migration_guardduty_image_mismatch"):
        subject.Migration().run(rig.digest, "apply", poll=1)


@pytest.mark.parametrize("content", [None, "not JSON", "{}", '{"ap-northeast-2": 914738172881}',
                                   '{"ap-northeast-2": "91473817288*"}'])
def test_guardduty_registry_map_missing_or_malformed_fails_closed(rig, monkeypatch, tmp_path, content):
    path = tmp_path / "registry.json"
    if content is not None:
        path.write_text(content)
    monkeypatch.setattr(subject, "GUARDDUTY_ACCOUNTS", path)
    rig.sidecars = [guardduty_sidecar(rig)]
    with pytest.raises(subject.ReleaseError, match="migration_guardduty_registry_unavailable"):
        subject.Migration().run(rig.digest, "apply", poll=1)


def test_guardduty_definition_access_denial_cannot_be_treated_as_absence(rig):
    rig.sidecars = [guardduty_sidecar(rig)]
    def denied(_):
        raise subject.ReleaseError("command_failed")
    rig.hooks[("ecs", "describe-task-definition")] = denied
    with pytest.raises(subject.ReleaseError, match="command_failed"):
        subject.Migration().run(rig.digest, "apply", poll=1)


def test_aws_injected_override_metadata_is_allowed_but_not_an_application_command(rig):
    agent = guardduty_sidecar(rig)
    rig.sidecars = [agent]
    rig.task_changes["overrides"] = {
        "containerOverrides": [{"name": "migration"}, {"name": agent["name"], "memory": 128,
                              "environment": [{"name": "AWS_MANAGED_SETTING", "value": "fixture"}]}],
        "inferenceAcceleratorOverrides": [],
    }
    migration = subject.Migration()
    record = migration.run(rig.digest, "apply", poll=1)
    rig.task_changes["overrides"]["containerOverrides"][0]["command"] = ["fake", "success"]
    with pytest.raises(subject.ReleaseError, match="migration_guardduty_definition_mismatch"):
        migration.verify_receipt(record["database"])


def test_guardduty_cannot_bypass_migration_failure_or_nonce(rig):
    rig.sidecars = [guardduty_sidecar(rig)]
    rig.container_changes["exitCode"] = 1
    with pytest.raises(subject.ReleaseError, match="migration_exit_or_digest_failed"):
        subject.Migration().run(rig.digest, "apply", poll=1)


def test_successful_guardduty_cannot_replace_the_migration_nonce_proof(rig):
    rig.sidecars = [guardduty_sidecar(rig)]
    rig.hooks[("logs", "get-log-events")] = lambda _: {
        "events": [{"message": json.dumps({**rig.proof(), "nonce": "e" * 32})}]}
    with pytest.raises(subject.ReleaseError, match="migration_receipt_log_missing"):
        subject.Migration().run(rig.digest, "apply", poll=1)


def test_captured_pull_failure_with_runtime_id_is_not_started_agent_success(rig, monkeypatch, capsys):
    # The real failed task has runtimeId but no exitCode or image metadata.
    agent = guardduty_sidecar(rig)
    agent.pop("exitCode")
    agent["reason"] = "CannotPullContainerError: ECR 403 PRIVATE_SECURITY_ERROR"
    rig.sidecars = [agent]
    monkeypatch.setattr(sys, "argv", ["ci_origin_migration.py", "run", "--digest", rig.digest, "--mode", "preview"])
    assert subject.main() == 1
    output = capsys.readouterr()
    assert "PRIVATE_SECURITY_ERROR" not in output.out + output.err
    assert "403" not in output.out + output.err
    assert json.loads(rig.receipt.read_text())["status"] != "succeeded"


def test_untracked_sql_cannot_receive_reviewed_source_identity(rig):
    rig.untracked = "terraform/v2/foundation/migrations/01ARZ3NDEKTSV4RRFFQ69G5FAV_unreviewed.sql"
    with pytest.raises(subject.ReleaseError, match="untracked_migration_input"):
        subject.Migration()
    assert rig.calls == []


def test_build_context_contains_only_committed_inputs_even_when_sql_is_gitignored(rig, monkeypatch, tmp_path):
    repository = tmp_path / "source"
    repository.mkdir()
    env = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null",
               GIT_AUTHOR_NAME="Fixture", GIT_COMMITTER_NAME="Fixture",
               GIT_AUTHOR_EMAIL="fixture@example.invalid", GIT_COMMITTER_EMAIL="fixture@example.invalid")
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=repository, env=env,
                                       stderr=subprocess.DEVNULL, text=True).strip()
    git("init", "-q")
    for path in subject.BUILD_INPUTS:
        destination = repository / path
        if path.endswith("/migrations"):
            destination = destination / "01ARZ3NDEKTSV4RRFFQ69G5FAV_reviewed.sql"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("reviewed input\n")
    (repository / ".gitignore").write_text("**/local.sql\n")
    git("add", ".")
    git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
    commit = git("rev-parse", "HEAD")
    (repository / "terraform/v2/foundation/migrations/local.sql").write_text("unreviewed SQL\n")
    monkeypatch.setenv("CI_COMMIT_SHA", commit)
    monkeypatch.setattr(subject, "ROOT", repository)
    monkeypatch.setattr(subject, "command", lambda argv, **kwargs: git(*argv[1:]))
    migration = subject.Migration()
    previous_umask = os.umask(0o077)
    try:
        context = migration.prepare_build()
    finally:
        os.umask(previous_umask)
    assert (context / "terraform/v2/foundation/migrations/01ARZ3NDEKTSV4RRFFQ69G5FAV_reviewed.sql").read_text() == "reviewed input\n"
    assert not (context / "terraform/v2/foundation/migrations/local.sql").exists()
    assert not (context / ".git").exists()
    assert (context / "scripts/v2/migrate.mjs").stat().st_mode & 0o777 == 0o644
    assert (context / "terraform/v2/foundation/migrations").stat().st_mode & 0o777 == 0o755
    with pytest.raises(subject.ReleaseError, match="migration_build_context_exists"):
        migration.prepare_build()


@pytest.mark.parametrize("key,value", [
    ("CI_COMMIT_SHA", "main"), ("CI_EXPECTED_ACCOUNT_ID", "123"),
    ("CI_EXPECTED_PROJECT", "other/*"), ("AWS_REGION", "ap-northeast-2;echo"),
    ("AWS_ENDPOINT_URL_ECS", "https://example.invalid"),
])
def test_invalid_context_rejected_before_aws(rig, monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    with pytest.raises(subject.ReleaseError):
        subject.Migration()
    assert not rig.calls


@pytest.mark.parametrize("field,value", [
    ("subnets", []), ("subnets", CONFIG["subnets"] * 2),
    ("security_group", "sg-*"),
    ("task_role_arn", f"arn:aws:iam::{ACCOUNT}:role/Administrator"),
    ("execution_role_arn", CONFIG["task_role_arn"]), ("log_group", "/ecs/other"),
])
def test_invalid_execution_config_rejected_before_aws(rig, monkeypatch, field, value):
    monkeypatch.setenv("AWSOPS_MIGRATION_CONFIG_JSON", json.dumps({**CONFIG, field: value}))
    with pytest.raises(subject.ReleaseError):
        subject.Migration()
    assert not rig.calls


@pytest.mark.parametrize("changed", ["source", "dirty"])
def test_source_guard_rejects_before_aws(rig, changed):
    setattr(rig, changed, "d" * 40 if changed == "source" else " M scripts/v2/migrate.mjs")
    with pytest.raises(subject.ReleaseError, match="migration_source_changed"):
        subject.Migration()
    assert not rig.calls


@pytest.mark.parametrize("account,role", [
    ("999999999999", PROJECT + "-ci-release"), (ACCOUNT, "Administrator"),
])
def test_rejects_foreign_caller_before_target_read(rig, account, role):
    rig.hooks[("sts", "get-caller-identity")] = lambda _: {
        "Account": account, "Arn": f"arn:aws:sts::{account}:assumed-role/{role}/session"}
    with pytest.raises(subject.ReleaseError, match="migration_caller_mismatch"):
        subject.Migration().target()
    assert ("rds", "describe-db-clusters") not in rig.operations()


@pytest.mark.parametrize("field,value", [
    ("DBClusterArn", DATABASE["DBClusterArn"].replace(ACCOUNT, "999999999999")),
    ("DBClusterIdentifier", "other-aurora"), ("DatabaseName", "other"),
    ("Status", "modifying"), ("Endpoint", "attacker.example"),
    ("Endpoint", DATABASE["Endpoint"] + ".attacker.example"),
    ("MasterUserSecret", {"SecretArn": SECRET, "SecretStatus": "rotating"}),
    ("MasterUserSecret", {"SecretArn": READER, "SecretStatus": "active"}),
])
def test_target_mismatch_never_registers_or_runs(rig, field, value):
    rig.database[field] = value
    with pytest.raises(subject.ReleaseError, match="migration_database_mismatch"):
        subject.Migration().run(rig.digest, "apply")
    assert ("ecs", "register-task-definition") not in rig.operations()


def test_reader_can_be_disabled_without_secret_fetch(rig, monkeypatch):
    monkeypatch.setenv("AWSOPS_MIGRATION_CONFIG_JSON", json.dumps({**CONFIG, "sql_reader_secret_arn": None}))
    record = subject.Migration().run(rig.digest, "apply")
    assert record["database"]["sql_reader_secret_arn"] is None


@pytest.mark.parametrize("mutation", ["digest", "tag", "repository", "manifest", "index"])
def test_image_provenance_failure_never_registers(rig, mutation):
    image = rig.respond(("ecr", "batch-get-image"), {
        "registryId": ACCOUNT, "repositoryName": PROJECT + "-web",
        "imageIds": [{"imageTag": "migration-" + COMMIT}],
    })
    item = image["images"][0]
    if mutation == "digest":
        item["imageId"]["imageDigest"] = "sha256:" + "e" * 64
    elif mutation == "tag":
        item["imageId"]["imageTag"] = "migration-" + "e" * 40
    elif mutation == "repository":
        item["repositoryName"] = "other-web"
    elif mutation == "manifest":
        item["imageManifest"] += " "
    else:
        item["imageManifest"] = json.dumps({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json"})
        rig.digest = "sha256:" + hashlib.sha256(item["imageManifest"].encode()).hexdigest()
        item["imageId"]["imageDigest"] = rig.digest
    rig.hooks[("ecr", "batch-get-image")] = lambda _: image
    with pytest.raises(subject.ReleaseError):
        subject.Migration().run(rig.digest, "apply")
    assert ("ecs", "register-task-definition") not in rig.operations()


@pytest.mark.parametrize("changes", [
    {"exitCode": 1}, {"exitCode": None}, {"imageDigest": "sha256:" + "e" * 64},
    {"image": REPO + ":migration-" + COMMIT}, {"name": "other"},
])
def test_exit_and_running_image_must_match(rig, changes):
    rig.container_changes = changes
    with pytest.raises(subject.ReleaseError, match="migration_exit_or_digest_failed"):
        subject.Migration().run(rig.digest, "apply")
    assert json.loads(rig.receipt.read_text())["status"] != "succeeded"


@pytest.mark.parametrize("field,value", [
    ("nonce", "f" * 32), ("commit", "f" * 40), ("mode", "preview"), ("status", "failed"),
])
def test_log_proof_is_not_interchangeable(rig, field, value):
    rig.hooks[("logs", "get-log-events")] = lambda _: {
        "events": [{"message": json.dumps({**rig.proof(), field: value})}]}
    with pytest.raises(subject.ReleaseError, match="migration_receipt_log_missing"):
        subject.Migration().run(rig.digest, "apply", poll=1)
    assert rig.operations().count(("logs", "get-log-events")) == 6


def test_eventual_consistency_during_normal_poll_is_supported(rig):
    rig.missing_reads = 2
    assert subject.Migration().run(rig.digest, "apply", poll=1)["status"] == "succeeded"
    assert rig.clock >= 2


def test_preview_receipt_cannot_authorize_release(rig):
    migration = subject.Migration()
    record = migration.run(rig.digest, "preview")
    with pytest.raises(subject.ReleaseError, match="migration_success_receipt_required"):
        migration.verify_receipt(record["database"])


def test_apply_receipt_rechecks_live_task_and_database(rig):
    migration = subject.Migration()
    record = migration.run(rig.digest, "apply")
    assert migration.verify_receipt(record["database"]) == record
    rig.container_changes["imageDigest"] = "sha256:" + "f" * 64
    with pytest.raises(subject.ReleaseError, match="migration_receipt_runtime_mismatch"):
        migration.verify_receipt(record["database"])


def test_receipt_rejects_changed_database(rig):
    migration = subject.Migration()
    record = migration.run(rig.digest, "apply")
    rig.database["Endpoint"] = DATABASE["Endpoint"].replace("cluster-example", "cluster-replacement")
    with pytest.raises(subject.ReleaseError, match="migration_success_receipt_required"):
        migration.verify_receipt(record["database"])


def test_private_receipt_cannot_be_world_readable_or_symlink(rig):
    migration = subject.Migration()
    migration.run(rig.digest, "apply")
    rig.receipt.chmod(0o644)
    with pytest.raises(subject.ReleaseError, match="private_file_invalid"):
        migration.load()
    rig.receipt.chmod(0o600)
    target = rig.receipt.with_suffix(".target")
    rig.receipt.rename(target)
    rig.receipt.symlink_to(target)
    with pytest.raises(subject.ReleaseError, match="private_file_invalid"):
        migration.load()


def launching_journal(rig):
    migration = subject.Migration()
    record = migration.run(rig.digest, "apply")
    record.pop("task")
    record.pop("proof")
    record["status"] = "launching"
    migration.save(record)
    rig.calls.clear()
    rig.hooks[("ecs", "describe-tasks")] = lambda _: {
        "tasks": [rig.task("STOPPED" if rig.stopped else "RUNNING")], "failures": []}
    return migration


def test_cleanup_reconciles_lost_launch_without_database_availability(rig):
    migration = launching_journal(rig)
    rig.database["Status"] = "unavailable"
    migration.cleanup()
    assert rig.stopped
    assert ("rds", "describe-db-clusters") not in rig.operations()
    assert ("ecs", "run-task") not in rig.operations()
    assert ("ecs", "deregister-task-definition") not in rig.operations()


def test_cleanup_does_not_stop_foreign_task(rig):
    migration = launching_journal(rig)
    rig.task_changes["startedBy"] = "d" * 32
    with pytest.raises(subject.ReleaseError, match="migration_cleanup_"):
        migration.cleanup()
    assert not rig.stopped


def test_cleanup_rejects_paginated_or_ambiguous_results(rig):
    migration = launching_journal(rig)
    rig.hooks[("ecs", "list-tasks")] = lambda _: {"taskArns": [TASK], "nextToken": "more"}
    with pytest.raises(subject.ReleaseError, match="migration_cleanup_incomplete"):
        migration.cleanup()
    assert not rig.stopped
    rig.hooks.pop(("ecs", "list-tasks"))
    rig.hooks[("ecs", "describe-tasks")] = lambda _: {
        "tasks": [rig.task(), {**rig.task(), "taskArn": TASK[:-1] + "d"}], "failures": []}
    with pytest.raises(subject.ReleaseError, match="migration_cleanup_ambiguous"):
        migration.cleanup()
    assert not rig.stopped


def test_cleanup_retries_initially_invisible_lost_launch(rig):
    """RunTask can succeed before ListTasks observes it (ECS eventual consistency)."""
    migration = launching_journal(rig)
    responses = iter([{"taskArns": []}, {"taskArns": [TASK]}])
    rig.hooks[("ecs", "list-tasks")] = lambda _: next(responses, {"taskArns": [TASK]})
    migration.cleanup()
    assert rig.stopped, "Cleanup reported success while the accepted migration task was still running"


def test_cleanup_retries_initially_missing_known_task(rig):
    migration = launching_journal(rig)
    record = migration.load()
    record["task"] = TASK
    migration.save(record)
    responses = iter([
        {"tasks": [], "failures": [{"arn": TASK, "reason": "MISSING"}]},
        {"tasks": [rig.task("RUNNING")], "failures": []},
    ])
    rig.hooks[("ecs", "describe-tasks")] = lambda _: next(
        responses, {"tasks": [rig.task("STOPPED" if rig.stopped else "RUNNING")], "failures": []})
    migration.cleanup()
    assert rig.stopped, "A transient MISSING response does not prove that the launched task stopped"


def test_cleanup_cannot_claim_success_when_launch_never_becomes_visible(rig):
    migration = launching_journal(rig)
    rig.hooks[("ecs", "list-tasks")] = lambda _: {"taskArns": []}
    with pytest.raises(subject.ReleaseError, match="migration_cleanup_"):
        migration.cleanup()
    assert not rig.stopped
    assert rig.clock <= 120


def test_cli_errors_do_not_expose_raw_cli_output(rig, monkeypatch, capsys):
    def failed(_):
        raise subject.ReleaseError("command_failed")
    rig.hooks[("sts", "get-caller-identity")] = failed
    monkeypatch.setattr(sys, "argv", ["ci_origin_migration.py", "check"])
    assert subject.main() == 1
    output = capsys.readouterr()
    assert json.loads(output.out) == {"status": "failed", "code": "command_failed"}
    assert output.err == ""
