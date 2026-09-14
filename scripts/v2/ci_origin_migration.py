#!/usr/bin/env python3
"""Run bundled migrations in private Fargate; CI never reads database credentials.

AWSOPS_MIGRATION_CONFIG_JSON is the nonsecret, operator-exported Terraform output.
CI_MIGRATION_RECEIPT must name a private file outside the checkout. Build
Dockerfile.origin-migration for ARM64 with SOURCE_COMMIT=$CI_COMMIT_SHA, push
migration-$CI_COMMIT_SHA, then pass the build action's digest to run. This module
is shared by web and AgentCore release workflows.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
import uuid

from ci_origin_common import (
    ROOT, ReleaseError, command, decode_json, private_bytes, require, sha256_digest,
)


class Migration:
    def __init__(self):
        self.context = {k: os.environ.get(v, "") for k, v in {
            "commit": "CI_COMMIT_SHA", "account": "CI_EXPECTED_ACCOUNT_ID",
            "project": "CI_EXPECTED_PROJECT", "region": "AWS_REGION",
        }.items()}
        c = self.context
        for key, pattern in {"commit": r"[a-f0-9]{40}", "account": r"[0-9]{12}",
                             "project": r"[a-z][a-z0-9-]{1,39}",
                             "region": r"[a-z]{2}-[a-z]+-[1-9][0-9]*"}.items():
            require(re.fullmatch(pattern, c[key]), "invalid_migration_context")
        require(not any(k.startswith("AWS_ENDPOINT_URL") and v for k, v in os.environ.items()),
                "aws_endpoint_override")
        self.config = decode_json(os.environ.get("AWSOPS_MIGRATION_CONFIG_JSON", ""))
        require(isinstance(self.config, dict) and set(self.config) == {
            "version", "account", "region", "project", "subnets", "security_group",
            "master_secret_arn", "sql_reader_secret_arn", "task_role_arn",
            "execution_role_arn", "log_group"}, "migration_configuration_missing")
        require(self.config["version"] == 1 and all(self.config[k] == c[k]
                for k in ("account", "region", "project")), "migration_config_scope")
        self.family = c["project"] + "-ci-migration"
        self.prefix = f'arn:aws:ecs:{c["region"]}:{c["account"]}:'
        self.cluster = self.prefix + "cluster/" + c["project"]
        self.repo = f'{c["account"]}.dkr.ecr.{c["region"]}.amazonaws.com/{c["project"]}-web'
        for key, suffix in (("task_role_arn", "-task"), ("execution_role_arn", "-execution")):
            require(self.config[key] == f'arn:aws:iam::{c["account"]}:role/{self.family}{suffix}',
                    "migration_role_scope")
        subnets = self.config["subnets"]
        require(isinstance(subnets, list) and 0 < len(subnets) <= 16
                and all(isinstance(s, str) and re.fullmatch(r"subnet-[a-f0-9]{17}", s) for s in subnets)
                and len(set(subnets)) == len(subnets)
                and re.fullmatch(r"sg-[a-f0-9]{17}", self.config["security_group"])
                and self.config["log_group"] == "/ecs/" + self.family, "migration_network_scope")
        self.path = Path(os.environ.get("CI_MIGRATION_RECEIPT", ""))
        require(self.path.is_absolute() and self.path.parent.is_dir()
                and not self.path.resolve().is_relative_to(ROOT), "invalid_migration_receipt")
        self.deadline = None
        self.source()

    def source(self):
        require(command(["git", "rev-parse", "HEAD"]) == self.context["commit"]
                and not command(["git", "status", "--porcelain", "--untracked-files=no"]),
                "migration_source_changed")

    def aws(self, service, operation, **params):
        timeout = 60 if self.deadline is None else min(60, self.deadline - time.monotonic())
        require(timeout > 0, "migration_timeout")
        return decode_json(command(["aws", service, operation, "--cli-input-json", json.dumps(params),
                                    "--region", self.context["region"], "--output", "json",
                                    "--no-cli-pager", "--no-paginate", "--cli-connect-timeout", "10",
                                    "--cli-read-timeout", "30"], timeout=timeout))

    def caller(self):
        c = self.context
        caller = self.aws("sts", "get-caller-identity")
        role = os.environ.get("CI_ROLE_ARN")
        roles = [f'arn:aws:iam::{c["account"]}:role/{c["project"]}-ci-{suffix}'
                 for suffix in ("release", "runtime")]
        require(role in roles and caller.get("Account") == c["account"]
                and str(caller.get("Arn", "")).startswith(
                    f'arn:aws:sts::{c["account"]}:assumed-role/{role.rsplit("/", 1)[-1]}/'),
                "migration_caller_mismatch")

    def target(self):
        self.caller()
        c = self.context
        result = self.aws("rds", "describe-db-clusters", DBClusterIdentifier=c["project"] + "-aurora")
        clusters = result.get("DBClusters", [])
        require(len(clusters) == 1, "migration_database_missing")
        db = clusters[0]
        secret = db.get("MasterUserSecret", {})
        require(db.get("DBClusterArn") == f'arn:aws:rds:{c["region"]}:{c["account"]}:cluster:{c["project"]}-aurora'
                and db.get("DBClusterIdentifier") == c["project"] + "-aurora"
                and db.get("DatabaseName") == "awsops" and db.get("Status") == "available"
                and secret.get("SecretArn") == self.config["master_secret_arn"]
                and secret.get("SecretStatus") == "active"
                and re.fullmatch(re.escape(c["project"] + "-aurora.cluster-") +
                                 r"[a-z0-9-]+\." + re.escape(c["region"]) + r"\.rds\.amazonaws\.com",
                                 db.get("Endpoint", "")), "migration_database_mismatch")
        prefix = f'arn:aws:secretsmanager:{c["region"]}:{c["account"]}:secret:'
        require(re.fullmatch(re.escape(prefix) + r"rds!cluster-[A-Za-z0-9-]+", secret["SecretArn"]),
                "migration_secret_scope")
        reader = self.config["sql_reader_secret_arn"]
        require(reader is None or (isinstance(reader, str) and re.fullmatch(
            re.escape(prefix + "ops/" + c["project"] + "/agent/sql-reader-") + r"[A-Za-z0-9]{6}", reader)),
            "migration_reader_scope")
        return {"version": 1, **c, "database": "awsops", "endpoint": db["Endpoint"],
                "secret_arn": secret["SecretArn"], "sql_reader_secret_arn": reader}

    def image(self, digest):
        require(sha256_digest(digest), "invalid_migration_digest")
        response = self.aws("ecr", "batch-get-image", registryId=self.context["account"],
                            repositoryName=self.context["project"] + "-web",
                            imageIds=[{"imageTag": "migration-" + self.context["commit"]}])
        images = response.get("images", [])
        require(not response.get("failures") and len(images) == 1, "migration_image_missing")
        image = images[0]
        raw = image.get("imageManifest", "")
        require(image.get("registryId") == self.context["account"]
                and image.get("repositoryName") == self.context["project"] + "-web"
                and image.get("imageId", {}).get("imageDigest") == digest
                and image.get("imageId", {}).get("imageTag") == "migration-" + self.context["commit"]
                and "sha256:" + hashlib.sha256(raw.encode()).hexdigest() == digest,
                "migration_build_digest_mismatch")
        manifest = decode_json(raw)
        require(manifest.get("schemaVersion") == 2 and manifest.get("mediaType") in {
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.v2+json"},
            "migration_single_platform_image_required")
        return self.repo + "@" + digest

    def save(self, record):
        if self.path.exists() or self.path.is_symlink():
            private_bytes(self.path)
        with tempfile.NamedTemporaryFile(mode="w", dir=self.path.parent, delete=False) as stream:
            name = stream.name
            os.chmod(name, 0o600)
            json.dump(record, stream)
        os.replace(name, self.path)

    def load(self):
        record = decode_json(private_bytes(self.path))
        require(record.get("version") == 1 and record.get("context") == self.context
                and record.get("config") == self.config and record.get("mode") in ("preview", "apply")
                and sha256_digest(record.get("digest")) and re.fullmatch(r"[a-f0-9]{32}", record.get("nonce", ""))
                and self.definition_arn(record.get("definition")), "migration_receipt_mismatch")
        return record

    def definition_arn(self, arn):
        return isinstance(arn, str) and re.fullmatch(
            re.escape(self.prefix + "task-definition/" + self.family + ":") + r"[1-9][0-9]*", arn)

    def owned(self, task, record):
        return (task.get("clusterArn") == self.cluster
                and task.get("taskDefinitionArn") == record["definition"]
                and task.get("startedBy") == record["nonce"]
                and task.get("launchType") == "FARGATE"
                and re.fullmatch(re.escape(self.prefix + "task/" + self.context["project"] + "/")
                                 + r"[a-f0-9]{32}", task.get("taskArn", ""))
                and (not record.get("task") or task["taskArn"] == record["task"]))

    def task(self, record):
        response = self.aws("ecs", "describe-tasks", cluster=self.cluster, tasks=[record["task"]])
        if not response.get("tasks") and all(f.get("reason") == "MISSING" for f in response.get("failures", [])):
            return None
        require(not response.get("failures") and len(response.get("tasks", [])) == 1
                and self.owned(response["tasks"][0], record), "migration_task_ownership")
        return response["tasks"][0]

    def run(self, digest, mode, timeout=1200, poll=10):
        require(mode in ("apply", "preview") and 0 < timeout <= 1200 and 0 < poll <= 10,
                "invalid_migration_run")
        require(not self.path.exists() and not self.path.is_symlink(), "migration_receipt_exists")
        database = self.target()
        image = self.image(digest)
        nonce = uuid.uuid4().hex
        config = self.config
        values = {"AWS_REGION": self.context["region"], "CI_COMMIT_SHA": self.context["commit"],
                  "CI_EXPECTED_ACCOUNT_ID": self.context["account"], "CI_EXPECTED_PROJECT": self.context["project"],
                  "CI_MIGRATION_MODE": mode, "CI_MIGRATION_NONCE": nonce,
                  "CI_MIGRATION_METADATA": json.dumps(database)}
        definition = dict(family=self.family, taskRoleArn=config["task_role_arn"],
                          executionRoleArn=config["execution_role_arn"], networkMode="awsvpc",
                          requiresCompatibilities=["FARGATE"], cpu="256", memory="512",
                          runtimePlatform={"cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX"},
                          tags=[{"key": "Project", "value": self.context["project"]}],
                          containerDefinitions=[{
                              "name": "migration", "image": image, "essential": True, "user": "1000:1000",
                              "stopTimeout": 30,
                              "environment": [{"name": k, "value": v} for k, v in values.items()],
                              "logConfiguration": {"logDriver": "awslogs", "options": {
                                  "awslogs-group": config["log_group"], "awslogs-region": self.context["region"],
                                  "awslogs-stream-prefix": "migration"}}}])
        result = self.aws("ecs", "register-task-definition", **definition)
        arn = result.get("taskDefinition", {}).get("taskDefinitionArn")
        require(self.definition_arn(arn), "migration_definition_scope")
        record = {"version": 1, "context": self.context, "config": config, "database": database,
                  "digest": digest, "mode": mode, "nonce": nonce, "definition": arn, "status": "launching"}
        self.save(record)
        self.source()
        params = dict(cluster=self.cluster, taskDefinition=arn, launchType="FARGATE", count=1,
                      clientToken=nonce, startedBy=nonce, enableExecuteCommand=False,
                      networkConfiguration={"awsvpcConfiguration": {
                          "subnets": config["subnets"], "securityGroups": [config["security_group"]],
                          "assignPublicIp": "DISABLED"}})
        self.deadline = time.monotonic() + timeout
        response = self.aws("ecs", "run-task", **params)
        tasks = response.get("tasks", [])
        require(not response.get("failures") and len(tasks) == 1 and self.owned(tasks[0], record),
                "migration_launch_failed")
        record.update(task=tasks[0]["taskArn"], status="running")
        self.save(record)
        while True:
            task = self.task(record)
            if task and task.get("lastStatus") == "STOPPED":
                break
            require(time.monotonic() + poll < self.deadline, "migration_timeout")
            time.sleep(poll)
        containers = task.get("containers", [])
        require(task.get("stopCode") == "EssentialContainerExited" and len(containers) == 1
                and containers[0].get("name") == "migration" and containers[0].get("exitCode") == 0
                and containers[0].get("image") == image and containers[0].get("imageDigest") == digest,
                "migration_exit_or_digest_failed")
        expected = {"type": "awsops-migration", "version": 1, "commit": self.context["commit"],
                    "mode": mode, "nonce": nonce, "status": "succeeded"}
        proved = False
        for attempt in range(6):
            try:
                logs = self.aws("logs", "get-log-events", logGroupName=config["log_group"],
                                logStreamName="migration/migration/" + record["task"].rsplit("/", 1)[-1],
                                limit=100)
                for event in logs.get("events", []):
                    try:
                        if decode_json(event.get("message", "")) == expected:
                            proved = True
                    except ReleaseError:
                        pass
            except ReleaseError:
                pass
            if proved:
                break
            if attempt < 5:
                time.sleep(poll)
        require(proved, "migration_receipt_log_missing")
        self.source()
        record.update(status="succeeded", proof=expected)
        self.save(record)
        return record

    def cleanup(self):
        if not self.path.exists():
            return
        record = self.load()
        self.caller()
        self.deadline = time.monotonic() + 120
        while not record.get("task") and time.monotonic() + 5 < self.deadline:
            # Covers a lost RunTask response without launching any new task.
            response = self.aws("ecs", "list-tasks", cluster=self.cluster, startedBy=record["nonce"])
            require(not response.get("nextToken"), "migration_cleanup_incomplete")
            arns = response.get("taskArns", [])
            if arns:
                tasks = self.aws("ecs", "describe-tasks", cluster=self.cluster, tasks=arns)
                require(not tasks.get("failures"), "migration_cleanup_incomplete")
                matches = [t for t in tasks.get("tasks", []) if self.owned(t, record)]
                require(len(matches) <= 1, "migration_cleanup_ambiguous")
                if matches:
                    record["task"] = matches[0]["taskArn"]
                    self.save(record)
            if not record.get("task"):
                time.sleep(5)
        require(record.get("task"), "migration_cleanup_unresolved_launch")
        if record.get("task"):
            task = self.task(record)
            while not task and time.monotonic() + 5 < self.deadline:
                time.sleep(5)
                task = self.task(record)
            require(task, "migration_cleanup_unresolved_task")
            if task and task.get("lastStatus") != "STOPPED":
                self.aws("ecs", "stop-task", cluster=self.cluster, task=record["task"],
                         reason="Origin migration workflow cleanup")
                while time.monotonic() + 5 < self.deadline:
                    task = self.task(record)
                    if task and task.get("lastStatus") == "STOPPED":
                        break
                    time.sleep(5)
                require(task and task.get("lastStatus") == "STOPPED", "migration_cleanup_timeout")
        # Retain the immutable revision for audit. DeregisterTaskDefinition has
        # no resource-level IAM scope; the CI role deliberately lacks it.

    def verify_receipt(self, database, mode="apply"):
        record = self.load()
        require(record["mode"] == mode and record["status"] == "succeeded"
                and record["database"] == database and self.target() == database
                and record.get("proof") == {
                    "type": "awsops-migration", "version": 1, "commit": self.context["commit"],
                    "mode": mode, "nonce": record["nonce"], "status": "succeeded"},
                "migration_success_receipt_required")
        task = self.task(record)
        containers = task.get("containers", []) if task else []
        require(task and task.get("lastStatus") == "STOPPED"
                and task.get("stopCode") == "EssentialContainerExited"
                and len(containers) == 1 and containers[0].get("name") == "migration"
                and containers[0].get("exitCode") == 0
                and containers[0].get("imageDigest") == record["digest"]
                and containers[0].get("image") == self.repo + "@" + record["digest"],
                "migration_receipt_runtime_mismatch")
        return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["check", "run", "cleanup"])
    parser.add_argument("--digest")
    parser.add_argument("--mode", choices=["preview", "apply"], default="preview")
    args = parser.parse_args()
    try:
        migration = Migration()
        if args.operation == "run":
            migration.run(args.digest, args.mode)
        elif args.operation == "cleanup":
            migration.cleanup()
        else:
            migration.target()
        print(json.dumps({"status": "ok", "operation": args.operation}))
    except (ReleaseError, OSError, KeyError, TypeError, ValueError) as error:
        print(json.dumps({"status": "failed", "code": str(error) if isinstance(error, ReleaseError)
                          else "migration_configuration_or_io"}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
