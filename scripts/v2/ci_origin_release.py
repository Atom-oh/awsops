#!/usr/bin/env python3
"""Bounded, operator-authorized origin web release controller (Python stdlib only).

Interface, in order:
  preflight
  check-smoke                         # check mode: HTTP only, no deployment proof
Or, after preflight, the opt-in deploy chain:
  record-build --digest sha256:<64 hex>
  migrate                             # verify the private task's apply receipt
  roll-web
  verify-web [--timeout-seconds 600] [--poll-seconds 10]
  smoke

Every invocation verifies CI_COMMIT_SHA against git HEAD. Preflight and deploy
commands pin owned AWS resource reads to CI_EXPECTED_ACCOUNT_ID, CI_EXPECTED_PROJECT,
CI_EXPECTED_URL and AWS_REGION; check-smoke uses the recorded preflight context.
CI_RELEASE_MANIFEST is a private absolute temporary file outside the checkout.
TF_ROOT is fixed to terraform/v2/foundation. Smoke also requires a private
CI_SMOKE_CREDENTIAL_FILE containing {"email": "...", "password": "..."}.
Preflight appends repository_uri, registry, cluster, service and public_url to
GITHUB_OUTPUT when supplied. These are validated, single-line non-secret values.

The trusted build job must push linux/arm64 to web-<CI_COMMIT_SHA> before
record-build. The private executor must complete before migrate verifies its
receipt; this controller does not build images or register task definitions.
Workflow concurrency must serialize releases: ECS UpdateService has no
compare-and-swap option. Observed drift fails closed; no automatic rollback,
Terraform apply, environment dump, raw command output or credential logging.
With a retained manifest in stage "rolling", another roll-web invocation only
reconciles reads. It never repeats promotion or UpdateService after an uncertain
response; an unresolved intent requires operator investigation.
"""
from __future__ import annotations

import argparse
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


from ci_origin_common import (
    ROOT, ReleaseError, command, decode_json, nonnegative_integer, private_bytes, require, sha256_digest,
)
TF_ROOT = "terraform/v2/foundation"
MAX_JSON = 4 * 1024 * 1024
IMAGE_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}
INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}


class ReadinessPending(ReleaseError):
    """A valid, owned ECS observation has not converged to the required state."""


def ready(condition, code):
    if not condition:
        raise ReadinessPending(code)


def origin(url):
    require(isinstance(url, str) and url and not re.search(r"[\s\\%]", url), "invalid_origin")
    try:
        parsed = urllib.parse.urlsplit(url)
        require(parsed.scheme == "https" and parsed.hostname and not parsed.username
                and not parsed.password and parsed.port in (None, 443)
                and not parsed.query and not parsed.fragment, "invalid_origin")
        require(re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?", parsed.hostname),
                "invalid_origin")
        return "https://" + parsed.hostname.lower()
    except ValueError:
        raise ReleaseError("invalid_origin") from None


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    # None of the pinned API contracts requires a redirect, including same-origin.
    # Reject before urllib can forward a password-bearing POST or authenticated GET.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ReleaseError("http_redirect_forbidden")


class Controller:
    def __init__(self):
        self.context = {
            key: os.environ.get(env, "") for key, env in (
                ("commit", "CI_COMMIT_SHA"), ("account", "CI_EXPECTED_ACCOUNT_ID"),
                ("project", "CI_EXPECTED_PROJECT"), ("url", "CI_EXPECTED_URL"),
                ("region", "AWS_REGION"),
            )
        }
        c = self.context
        require(re.fullmatch(r"[0-9a-fA-F]{40}", c["commit"]), "invalid_commit")
        c["commit"] = c["commit"].lower()
        require(re.fullmatch(r"[0-9]{12}", c["account"]), "invalid_account")
        require(re.fullmatch(r"[a-z][a-z0-9-]{1,39}", c["project"]), "invalid_project")
        require(re.fullmatch(r"(af|ap|ca|eu|il|me|mx|sa|us)-(central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9][0-9]*", c["region"]),
                "invalid_region")
        c["url"] = origin(c["url"])
        require(urllib.parse.urlsplit(os.environ["CI_EXPECTED_URL"]).path in ("", "/"), "invalid_origin")
        require(os.environ.get("TF_ROOT", TF_ROOT) in (TF_ROOT, str(ROOT / TF_ROOT)), "invalid_tf_root")
        c["tf_root"] = TF_ROOT
        reader = os.environ.get("CI_SQL_READER_SECRET_ARN", "")
        reader_prefix = f'arn:aws:secretsmanager:{c["region"]}:{c["account"]}:secret:ops/{c["project"]}/agent/sql-reader-'
        require(reader == "disabled" or re.fullmatch(re.escape(reader_prefix) + r"[A-Za-z0-9]{6}", reader),
                "sql_reader_declaration_required")
        c["sql_reader_secret_arn"] = None if reader == "disabled" else reader
        path = os.environ.get("CI_RELEASE_MANIFEST", "")
        self.path = Path(path)
        require(path and self.path.is_absolute() and not self.path.resolve().is_relative_to(ROOT)
                and self.path.parent.is_dir(), "invalid_manifest_path")
        require(not any(k.startswith("AWS_ENDPOINT_URL") and v for k, v in os.environ.items()),
                "aws_endpoint_override")
        self.partition = ("aws-cn" if c["region"].startswith("cn-")
                          else "aws-us-gov" if c["region"].startswith("us-gov-") else "aws")
        suffix = "amazonaws.com.cn" if self.partition == "aws-cn" else "amazonaws.com"
        self.repo_name = c["project"] + "-web"
        self.repo = f'{c["account"]}.dkr.ecr.{c["region"]}.{suffix}/{self.repo_name}'
        self.cluster = c["project"]
        self.service_name = c["project"] + "-web"
        self.arn_prefix = f'arn:{self.partition}:ecs:{c["region"]}:{c["account"]}:'
        self.cluster_arn = self.arn_prefix + "cluster/" + self.cluster
        self.service_arn = self.arn_prefix + f"service/{self.cluster}/{self.service_name}"
        self.deadline = None
        self.database = None
        self.check_source()

    def check_source(self):
        require(command(["git", "rev-parse", "HEAD"]).lower() == self.context["commit"], "head_mismatch")
        require(not command(["git", "status", "--porcelain", "--untracked-files=no"]),
                "tracked_source_modified")

    def aws(self, service, action, *args):
        timeout = 60
        if self.deadline is not None:
            timeout = min(timeout, self.deadline - time.monotonic())
            require(timeout > 0, "verification_timeout")
        options = {"timeout": timeout}
        if (service, action) in {("ecr", "put-image"), ("ecs", "update-service")}:
            # Also disable retries inside the AWS CLI after an uncertain response.
            options["env"] = {**os.environ, "AWS_MAX_ATTEMPTS": "1"}
        result = decode_json(command([
            "aws", service, action, *args, "--region", self.context["region"],
            "--output", "json", "--no-cli-pager", "--cli-connect-timeout", "10",
            "--cli-read-timeout", "30",
        ], **options))
        require(isinstance(result, dict), "invalid_aws_response")
        return result

    def wait_for_reads(self, read, timeout_seconds=120, poll_seconds=5):
        require(type(timeout_seconds) is int and 1 <= timeout_seconds <= 1800
                and type(poll_seconds) is int and 1 <= poll_seconds <= 30, "invalid_wait_bound")
        previous = self.deadline
        deadline = time.monotonic() + timeout_seconds
        self.deadline = deadline if previous is None else min(previous, deadline)
        try:
            while True:
                require(time.monotonic() < self.deadline, "verification_timeout")
                try:
                    result = read()
                    require(time.monotonic() <= self.deadline, "verification_timeout")
                    return result
                except ReadinessPending:
                    # API/identity/shape failures are ReleaseError, not readiness.
                    # Each AWS call also receives the remaining command timeout.
                    remaining = self.deadline - time.monotonic()
                    require(remaining > 0, "verification_timeout")
                    time.sleep(min(poll_seconds, remaining))
        finally:
            self.deadline = previous

    def check_scope(self):
        require(self.aws("sts", "get-caller-identity").get("Account") == self.context["account"],
                "account_mismatch")
        repositories = self.aws("ecr", "describe-repositories", "--registry-id", self.context["account"],
                                "--repository-names", self.repo_name).get("repositories")
        require(isinstance(repositories, list) and len(repositories) == 1
                and repositories[0].get("registryId") == self.context["account"]
                and repositories[0].get("repositoryName") == self.repo_name
                and repositories[0].get("repositoryUri") == self.repo, "repository_scope_mismatch")
        identifier = self.context["project"] + "-aurora"
        clusters = self.aws("rds", "describe-db-clusters", "--db-cluster-identifier", identifier).get("DBClusters")
        require(isinstance(clusters, list) and len(clusters) == 1, "database_missing")
        db = clusters[0]
        expected_arn = f'arn:aws:rds:{self.context["region"]}:{self.context["account"]}:cluster:{identifier}'
        secret = db.get("MasterUserSecret") or {}
        secret_prefix = f'arn:aws:secretsmanager:{self.context["region"]}:{self.context["account"]}:secret:'
        endpoint = db.get("Endpoint", "")
        require(db.get("DBClusterArn") == expected_arn and db.get("DBClusterIdentifier") == identifier
                and db.get("Status") == "available" and db.get("DatabaseName") == "awsops"
                and isinstance(endpoint, str) and re.fullmatch(r"[a-z0-9][a-z0-9.-]+", endpoint)
                and endpoint.endswith("." + self.context["region"] + ".rds.amazonaws.com")
                and secret.get("SecretStatus") == "active"
                and isinstance(secret.get("SecretArn"), str)
                and re.fullmatch(re.escape(secret_prefix) + r"[A-Za-z0-9/_+=.@!-]+-[A-Za-z0-9]{6}", secret["SecretArn"]),
                "database_scope_mismatch")
        self.database = {
            "version": 1,
            **{key: self.context[key] for key in ("commit", "account", "region", "project")},
            "database": "awsops", "endpoint": endpoint, "secret_arn": secret["SecretArn"],
            "sql_reader_secret_arn": self.context["sql_reader_secret_arn"],
        }
        return self.database

    def save(self, state):
        if self.path.exists() or self.path.is_symlink():
            private_bytes(self.path)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=self.path.parent, delete=False) as file:
                temporary = file.name
                os.chmod(temporary, 0o600)
                json.dump(state, file, sort_keys=True)
                file.write("\n")
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
        except OSError:
            raise ReleaseError("manifest_write_failed") from None
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)

    def load(self, *stages, check_scope=True):
        state = decode_json(private_bytes(self.path))
        require(isinstance(state, dict) and state.get("version") == 1
                and state.get("context") == self.context, "manifest_context_mismatch")
        require(state.get("stage") in stages, "release_order_invalid")
        snapshot = state.get("snapshot", {})
        require(snapshot.get("service_arn") == self.service_arn
                and snapshot.get("cluster_arn") == self.cluster_arn
                and self.task_definition_arn(snapshot.get("task_definition"))
                and self.deployment_id(snapshot.get("primary_id"))
                and snapshot.get("web", {}).get("image") == self.repo + ":web-latest"
                and type(snapshot.get("desired_count")) is int
                and 0 < snapshot["desired_count"] <= 1000, "invalid_snapshot")
        if check_scope:
            self.check_scope()
            require(state.get("database") == self.database, "database_context_moved")
        return state

    def task_definition_arn(self, value):
        return isinstance(value, str) and re.fullmatch(
            re.escape(self.arn_prefix + "task-definition/" + self.service_name) + r":[1-9][0-9]*", value)

    @staticmethod
    def deployment_id(value):
        return isinstance(value, str) and re.fullmatch(r"ecs-svc/[0-9]+", value)

    def service(self, data=None):
        if data is None:
            result = self.aws("ecs", "describe-services", "--cluster", self.cluster,
                              "--services", self.service_name)
            require(not result.get("failures") and isinstance(result.get("services"), list)
                    and len(result["services"]) == 1, "service_unavailable")
            data = result["services"][0]
        require(data.get("serviceArn") == self.service_arn and data.get("clusterArn") == self.cluster_arn
                and data.get("serviceName") == self.service_name and data.get("status") == "ACTIVE"
                and data.get("deploymentController", {}).get("type") == "ECS"
                and self.task_definition_arn(data.get("taskDefinition")), "service_scope_mismatch")
        require(all(nonnegative_integer(data.get(k)) for k in ("desiredCount", "runningCount", "pendingCount"))
                and 0 < data["desiredCount"] <= 1000, "service_counts_invalid")
        deployments = data.get("deployments")
        require(isinstance(deployments, list) and deployments
                and all(isinstance(d, dict) and self.deployment_id(d.get("id")) for d in deployments),
                "deployment_missing")
        require(all(nonnegative_integer(d.get(k)) for d in deployments
                    for k in ("runningCount", "pendingCount")), "deployment_counts_invalid")
        primary = [d for d in deployments if d.get("status") == "PRIMARY"]
        require(len(primary) == 1 and self.deployment_id(primary[0].get("id")), "deployment_missing")
        require(nonnegative_integer(primary[0].get("desiredCount")), "deployment_counts_invalid")
        require(primary[0].get("taskDefinition") == data["taskDefinition"], "deployment_definition_mismatch")
        return data, primary[0]

    @staticmethod
    def stable(service, primary):
        require(primary.get("rolloutState") in ("COMPLETED", "IN_PROGRESS"), "deployment_failed_or_unknown")
        ready(primary["rolloutState"] == "COMPLETED", "deployment_not_completed")
        desired = service["desiredCount"]
        ready(service["runningCount"] == desired and service["pendingCount"] == 0
                and primary.get("desiredCount") == desired
                and primary.get("runningCount") == desired and primary.get("pendingCount") == 0,
                "deployment_counts_mismatch")
        ready(all(d.get("runningCount") == 0 and d.get("pendingCount") == 0
                    for d in service["deployments"] if d["id"] != primary["id"]), "old_tasks_remaining")

    def snapshot(self):
        return self.wait_for_reads(self.read_snapshot)

    def read_snapshot(self):
        service, primary = self.service()
        # Old health is advisory. A failed image must not make recovery depend
        # on first obtaining a healthy deployment of that same failed image.
        definition = self.aws("ecs", "describe-task-definition",
                              "--task-definition", service["taskDefinition"]).get("taskDefinition", {})
        require(definition.get("taskDefinitionArn") == service["taskDefinition"]
                and definition.get("status") == "ACTIVE"
                and definition.get("runtimePlatform") == {
                    "cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX"},
                "task_platform_mismatch")
        web = [c for c in definition.get("containerDefinitions", []) if c.get("name") == "web"]
        require(len(web) == 1, "web_container_missing")
        web = web[0]
        require(web.get("image") == self.repo + ":web-latest" and web.get("essential") is True,
                "web_image_mismatch")
        require(any(p.get("containerPort") == 3000 for p in web.get("portMappings", []))
                and any(e.get("name") == "HOSTNAME" and e.get("value") == "0.0.0.0"
                        for e in web.get("environment", [])), "web_runtime_invalid")
        domains = [e.get("value") for e in web.get("environment", []) if e.get("name") == "APP_DOMAIN"]
        endpoints = [e.get("value") for e in web.get("environment", []) if e.get("name") == "AURORA_ENDPOINT"]
        require(domains == [urllib.parse.urlsplit(self.context["url"]).hostname]
                and self.database and endpoints == [self.database["endpoint"]], "web_target_mismatch")
        check = web.get("healthCheck", {}).get("command")
        require(isinstance(check, list) and any(isinstance(s, str) and "/api/health" in s for s in check),
                "web_health_check_missing")
        self.probe_task_reads()
        after, current = self.service()
        ready(current["id"] == primary["id"] and after["taskDefinition"] == service["taskDefinition"]
              and after["desiredCount"] == service["desiredCount"], "service_snapshot_moved")
        return {"service_arn": self.service_arn, "cluster_arn": self.cluster_arn,
                "task_definition": service["taskDefinition"], "primary_id": primary["id"],
                "desired_count": service["desiredCount"],
                "web": {"name": "web", "image": web["image"], "essential": True,
                        "container_port": 3000, "health_check": True}}

    def probe_task_reads(self):
        # A bounded IAM/identity probe, not a complete old-deployment health check.
        params = {"cluster": self.cluster, "serviceName": self.service_name,
                  "desiredStatus": "RUNNING", "maxResults": 100}
        page = self.aws("ecs", "list-tasks", "--cli-input-json", json.dumps(params), "--no-paginate")
        arns = page.get("taskArns")
        pattern = re.escape(self.arn_prefix + "task/" + self.cluster + "/") + r"[0-9a-f]{32}"
        require(isinstance(arns, list) and len(arns) <= 100
                and all(isinstance(a, str) and re.fullmatch(pattern, a) for a in arns)
                and len(set(arns)) == len(arns)
                and (page.get("nextToken") is None or isinstance(page["nextToken"], str)),
                "task_probe_listing_invalid")
        # Do not skip authorization when the service has no tasks. A syntactically
        # valid owned missing ARN produces MISSING only after the API read succeeds.
        batch = arns or [self.arn_prefix + "task/" + self.cluster + "/" + "0" * 32]
        response = self.aws("ecs", "describe-tasks", "--cluster", self.cluster, "--tasks", *batch)
        tasks, failures = response.get("tasks"), response.get("failures", [])
        require(isinstance(tasks, list) and isinstance(failures, list), "task_probe_invalid")
        seen = []
        for task in tasks:
            require(isinstance(task, dict) and task.get("taskArn") in batch
                    and task.get("clusterArn") == self.cluster_arn
                    and task.get("group") == "service:" + self.service_name
                    and self.task_definition_arn(task.get("taskDefinitionArn")), "task_probe_scope_mismatch")
            seen.append(task["taskArn"])
        for failure in failures:
            require(isinstance(failure, dict) and failure.get("arn") in batch
                    and failure.get("reason") == "MISSING", "task_probe_failed")
            seen.append(failure["arn"])
        require(len(seen) == len(set(seen)) and set(seen) == set(batch), "task_probe_incomplete")

    def preflight(self):
        if self.path.exists() or self.path.is_symlink():
            require(not private_bytes(self.path), "manifest_already_exists")
        database = self.check_scope()
        state = {"version": 1, "context": self.context, "database": database,
                 "stage": "preflight", "snapshot": self.snapshot()}
        self.save(state)
        self.workflow_outputs()
        return state

    def workflow_outputs(self):
        output = os.environ.get("GITHUB_OUTPUT")
        if not output:
            return
        path = Path(output)
        require(path.is_absolute() and path.resolve() != self.path.resolve(), "invalid_workflow_output")
        values = {"repository_uri": self.repo, "registry": self.repo.split("/")[0],
                  "cluster": self.cluster, "service": self.service_name, "public_url": self.context["url"]}
        require(all("\n" not in value and "\r" not in value for value in values.values()),
                "invalid_workflow_output")
        try:
            fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
            with os.fdopen(fd, "w") as file:
                info = os.fstat(file.fileno())
                require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid(), "invalid_workflow_output")
                file.write("".join(f"{key}={value}\n" for key, value in values.items()))
        except OSError:
            raise ReleaseError("workflow_output_failed") from None

    def ecr_image(self, reference):
        response = self.aws("ecr", "batch-get-image", "--registry-id", self.context["account"],
                            "--repository-name", self.repo_name, "--image-ids", reference)
        images = response.get("images")
        require(not response.get("failures") and isinstance(images, list) and len(images) == 1,
                "image_unavailable")
        image = images[0]
        image_digest = image.get("imageId", {}).get("imageDigest")
        raw = image.get("imageManifest")
        require(image.get("registryId") == self.context["account"]
                and image.get("repositoryName") == self.repo_name
                and sha256_digest(image_digest) and isinstance(raw, str), "image_scope_mismatch")
        key, expected = reference.split("=", 1)
        require(image.get("imageId", {}).get(key) == expected, "image_reference_mismatch")
        require("sha256:" + hashlib.sha256(raw.encode()).hexdigest() == image_digest, "image_content_mismatch")
        manifest = decode_json(raw)
        require(isinstance(manifest, dict) and manifest.get("schemaVersion") == 2
                and manifest.get("mediaType") == image.get("imageManifestMediaType"), "invalid_image_manifest")
        return image_digest, raw, manifest

    @staticmethod
    def image_manifest(manifest):
        require(manifest.get("mediaType") in IMAGE_TYPES
                and sha256_digest(manifest.get("config", {}).get("digest"))
                and isinstance(manifest.get("layers"), list)
                and all(sha256_digest(layer.get("digest")) for layer in manifest["layers"]),
                "invalid_image_manifest")

    def resolve_build(self, expected_digest):
        require(sha256_digest(expected_digest), "invalid_image_digest")
        found, raw, manifest = self.ecr_image("imageTag=web-" + self.context["commit"])
        require(found == expected_digest, "build_digest_mismatch")
        arm = found
        if manifest["mediaType"] in INDEX_TYPES:
            children = manifest.get("manifests")
            require(isinstance(children, list) and 0 < len(children) <= 32, "invalid_image_index")
            matches = [m for m in children if m.get("platform", {}).get("os") == "linux"
                       and m.get("platform", {}).get("architecture") == "arm64"
                       and m["platform"].get("variant") in (None, "v8")]
            require(len(matches) == 1 and sha256_digest(matches[0].get("digest"))
                    and matches[0].get("mediaType") in IMAGE_TYPES, "arm64_image_missing")
            arm = matches[0]["digest"]
            _, child_raw, child = self.ecr_image("imageDigest=" + arm)
            require(matches[0].get("size") == len(child_raw.encode()), "image_content_mismatch")
            self.image_manifest(child)
        else:
            self.image_manifest(manifest)
        return {"commit": self.context["commit"], "digest": found, "arm64_digest": arm,
                "media_type": manifest["mediaType"]}, raw

    def build_proof(self, state):
        saved = state.get("build", {})
        actual, raw = self.resolve_build(saved.get("digest"))
        require(saved == actual, "build_proof_mismatch")
        return actual, raw

    def migration_proof(self, state):
        require(state.get("migration") == {"commit": self.context["commit"], "status": "succeeded"},
                "migration_proof_missing")

    def record_build(self, image_digest):
        state = self.load("preflight")
        build, _ = self.resolve_build(image_digest)
        state.update(build=build, stage="built")
        self.save(state)
        return state

    def run_migration(self, state, *, preview=False):
        require(all(os.environ.get(k, "") in ("", "0") for k in ("DRY_RUN", "OFFLINE", "STATUS", "BOOTSTRAP"))
                and not any(os.environ.get(k) for k in ("MAKEFLAGS", "MFLAGS", "GNUMAKEFLAGS", "MAKEFILES")),
                "migration_options_forbidden")
        from ci_origin_migration import Migration
        Migration().verify_receipt(state["database"], "preview" if preview else "apply")
        self.check_source()

    def preview_migrations(self):
        state = self.load("preflight")
        self.run_migration(state, preview=True)
        return state

    def migrate(self):
        state = self.load("built")
        self.build_proof(state)
        self.run_migration(state)
        state.update(migration={"commit": self.context["commit"], "status": "succeeded"}, stage="migrated")
        self.save(state)
        return state

    def roll_web(self):
        state = self.load("migrated", "rolling")
        self.migration_proof(state)
        if state["stage"] == "rolling":
            return self.reconcile_roll(state)
        require(self.snapshot() == state["snapshot"], "service_snapshot_moved")
        build, raw = self.build_proof(state)
        latest, _, _ = self.ecr_image("imageTag=web-latest")
        if latest != build["digest"]:
            response = self.aws("ecr", "put-image", "--registry-id", self.context["account"],
                                "--repository-name", self.repo_name, "--image-tag", "web-latest",
                                "--image-manifest", raw, "--image-manifest-media-type", build["media_type"],
                                "--image-digest", build["digest"])
            require(response.get("image", {}).get("imageId", {}).get("imageDigest") == build["digest"],
                    "image_promotion_failed")
        require(self.ecr_image("imageTag=web-latest")[0] == build["digest"], "image_promotion_failed")
        self.build_proof(state)
        require(self.snapshot() == state["snapshot"], "service_snapshot_moved")
        self.check_source()
        # Journal before sending the non-idempotent request. A crash or API error
        # cannot make another invocation issue a second rollout with this manifest.
        state.update(intent=self.roll_intent(state), stage="rolling")
        self.save(state)
        result = self.aws("ecs", "update-service", "--cluster", self.cluster,
                          "--service", self.service_name, "--force-new-deployment")
        return self.reconcile_roll(state, result.get("service", {}))

    def roll_intent(self, state):
        return {"commit": self.context["commit"], "digest": state["build"]["digest"],
                "previous_deployment_id": state["snapshot"]["primary_id"],
                "task_definition": state["snapshot"]["task_definition"],
                "desired_count": state["snapshot"]["desired_count"]}

    def reconcile_roll(self, state, supplied=None):
        require(state.get("intent") == self.roll_intent(state), "roll_intent_mismatch")
        initial = [] if supplied is None else [supplied]
        def read():
            self.build_proof(state)
            require(self.ecr_image("imageTag=web-latest")[0] == state["intent"]["digest"], "release_tag_moved")
            service, primary = self.service(initial.pop() if initial else None)
            require(service["taskDefinition"] == state["snapshot"]["task_definition"]
                    and service["desiredCount"] == state["snapshot"]["desired_count"], "service_snapshot_moved")
            ready(primary["id"] != state["snapshot"]["primary_id"], "new_deployment_missing")
            require(primary.get("rolloutState") in ("IN_PROGRESS", "COMPLETED"), "deployment_failed_or_unknown")
            self.check_source()
            return primary["id"]
        deployment = self.wait_for_reads(read)
        state.update(roll={"commit": self.context["commit"], "digest": state["build"]["digest"],
                           "deployment_id": deployment}, stage="rolled")
        self.save(state)
        return state

    def roll_proof(self, state):
        self.migration_proof(state)
        roll = state.get("roll", {})
        require(roll.get("commit") == self.context["commit"]
                and roll.get("digest") == state.get("build", {}).get("digest")
                and self.deployment_id(roll.get("deployment_id"))
                and roll["deployment_id"] != state["snapshot"]["primary_id"], "roll_proof_missing")
        self.build_proof(state)
        require(self.ecr_image("imageTag=web-latest")[0] == roll["digest"], "release_tag_moved")

    def current_deployment(self, state):
        service, primary = self.service()
        require(service["taskDefinition"] == state["snapshot"]["task_definition"]
                and service["desiredCount"] == state["snapshot"]["desired_count"], "service_snapshot_moved")
        ready(primary["id"] == state["roll"]["deployment_id"], "deployment_replaced_or_rolled_back")
        require(primary.get("rolloutState") in ("COMPLETED", "IN_PROGRESS"), "deployment_failed_or_unknown")
        return service, primary

    def running_tasks(self, state):
        arns, token = [], None
        for _ in range(10):
            # The CLI exposes paginator flags, not API maxResults/nextToken.
            # JSON input with auto-pagination disabled preserves the bounded
            # service API cursor rather than mixing in CLI starting-token state.
            params = {"cluster": self.cluster, "serviceName": self.service_name,
                      "desiredStatus": "RUNNING", "maxResults": 100}
            if token:
                params["nextToken"] = token
            page = self.aws("ecs", "list-tasks", "--cli-input-json", json.dumps(params), "--no-paginate")
            require(isinstance(page.get("taskArns"), list), "tasks_missing")
            arns += page["taskArns"]
            token = page.get("nextToken")
            if not token:
                break
            require(isinstance(token, str), "invalid_task_page")
        pattern = re.escape(self.arn_prefix + "task/" + self.cluster + "/") + r"[0-9a-f]{32}"
        require(all(isinstance(a, str) and re.fullmatch(pattern, a) for a in arns), "task_scope_mismatch")
        ready(not token and len(arns) == state["snapshot"]["desired_count"]
              and len(set(arns)) == len(arns), "task_count_mismatch")
        checked, digests = set(), set()
        allowed = {state["build"]["digest"], state["build"]["arm64_digest"]}
        for start in range(0, len(arns), 100):
            batch = arns[start:start + 100]
            result = self.aws("ecs", "describe-tasks", "--cluster", self.cluster, "--tasks", *batch)
            tasks = result.get("tasks")
            failures = result.get("failures", [])
            require(isinstance(tasks, list) and all(isinstance(t, dict) for t in tasks)
                    and isinstance(failures, list)
                    and all(isinstance(f, dict) and f.get("reason") == "MISSING"
                            and f.get("arn") in batch for f in failures), "tasks_unavailable")
            ready(not failures and len(tasks) == len(batch), "tasks_unavailable")
            for task in tasks:
                arn = task.get("taskArn")
                require(arn in batch and arn not in checked and task.get("clusterArn") == self.cluster_arn
                        and task.get("group") == "service:" + self.service_name
                        and self.deployment_id(task.get("startedBy"))
                        and self.task_definition_arn(task.get("taskDefinitionArn")),
                        "task_release_mismatch")
                ready(task["startedBy"] == state["roll"]["deployment_id"]
                      and task["taskDefinitionArn"] == state["snapshot"]["task_definition"],
                      "task_release_mismatch")
                ready(task.get("lastStatus") == "RUNNING" and task.get("desiredStatus") == "RUNNING"
                        and task.get("healthStatus") == "HEALTHY", "task_not_healthy")
                web = [c for c in task.get("containers", []) if c.get("name") == "web"]
                require(len(web) <= 1, "web_container_invalid")
                ready(len(web) == 1, "web_container_missing")
                require(web[0].get("image") == state["snapshot"]["web"]["image"]
                        and (web[0].get("imageDigest") in (None, "") or sha256_digest(web[0]["imageDigest"])),
                        "web_image_mismatch")
                ready(web[0].get("lastStatus") == "RUNNING"
                        and web[0].get("healthStatus") == "HEALTHY"
                        and web[0].get("imageDigest") in allowed, "web_runtime_digest_or_health_mismatch")
                checked.add(arn)
                digests.add(web[0]["imageDigest"])
        require(checked == set(arns), "tasks_unavailable")
        return {"task_count": len(checked), "runtime_digests": sorted(digests)}

    def verify_web(self, timeout_seconds=600, poll_seconds=10):
        state = self.load("rolled")
        def read():
            self.roll_proof(state)
            self.stable(*self.current_deployment(state))
            tasks = self.running_tasks(state)
            self.stable(*self.current_deployment(state))
            return tasks
        tasks = self.wait_for_reads(read, timeout_seconds, poll_seconds)
        self.check_source()
        state.update(verified={**state["roll"], **tasks}, stage="verified")
        self.save(state)
        return state

    def smoke(self):
        state = self.load("verified")
        self.roll_proof(state)
        verified = state.get("verified", {})
        runtime_digests = verified.get("runtime_digests")
        require(all(verified.get(k) == v for k, v in state["roll"].items())
                and verified.get("task_count") == state["snapshot"]["desired_count"]
                and isinstance(runtime_digests, list) and runtime_digests
                and all(d in (state["build"]["digest"], state["build"]["arm64_digest"]) for d in runtime_digests),
                "runtime_proof_missing")
        self.wait_for_reads(lambda: self.stable(*self.current_deployment(state)))
        checks = self.http_checks()
        self.wait_for_reads(lambda: self.stable(*self.current_deployment(state)))
        self.check_source()
        state.update(smoke={**state["roll"], "status": "succeeded", "checks": checks}, stage="smoked")
        self.save(state)
        return state

    def check_smoke(self):
        # Source/context and prior preflight are required, but this branch performs
        # only HTTP checks. Leave the preflight manifest byte-for-byte unchanged.
        state = self.load("preflight", check_scope=False)
        self.http_checks()
        return state

    def http_checks(self):
        credentials = decode_json(private_bytes(Path(os.environ.get("CI_SMOKE_CREDENTIAL_FILE", "")), 4096))
        email, password = credentials.get("email"), credentials.get("password")
        require(isinstance(email, str) and 0 < len(email) <= 254
                and isinstance(password, str) and 0 < len(password) <= 256, "invalid_smoke_credentials")
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(RejectRedirects(), urllib.request.HTTPCookieProcessor(jar))

        def request(path, payload=None):
            headers = {"Accept": "application/json", "Cache-Control": "no-cache"}
            body = None
            if payload is not None:
                headers["Content-Type"] = "application/json"
                body = json.dumps(payload).encode()
            req = urllib.request.Request(self.context["url"] + path, data=body, headers=headers,
                                         method="POST" if payload is not None else "GET")
            try:
                with opener.open(req, timeout=20) as response:
                    require(origin(response.geturl()) == self.context["url"], "http_origin_mismatch")
                    require(response.status == 200, "http_check_failed")
                    require(response.headers.get_content_type() == "application/json", "http_not_json")
                    data = decode_json(response.read(MAX_JSON + 1))
            except (urllib.error.URLError, OSError, ValueError):
                raise ReleaseError("http_check_failed") from None
            require(isinstance(data, dict) and "error" not in data and data.get("status") != "error",
                    "http_contract_failed")
            return data

        login = request("/api/auth/login", {"email": email, "password": password, "remember": False, "next": "/"})
        require(login.get("ok") is True and isinstance(login.get("redirect"), str), "login_failed")
        require(origin(urllib.parse.urljoin(self.context["url"] + "/", login["redirect"])) == self.context["url"],
                "login_redirect_forbidden")
        require(any(c.name == "awsops_token" and c.value and c.secure
                    and c.domain.lstrip(".").lower() == urllib.parse.urlsplit(self.context["url"]).hostname
                    for c in jar), "login_cookie_missing")
        me = request("/api/me")
        require(isinstance(me.get("sub"), str) and me["sub"]
                and isinstance(me.get("email"), str) and me["email"].casefold() == email.casefold()
                and me.get("isAdmin") is False,
                "authenticated_identity_mismatch")
        health = request("/api/health")
        require(health.get("status") == "ok" and health.get("service") == "awsops-web", "health_check_failed")
        db = request("/api/db")
        require(db.get("status") == "ok" and nonnegative_integer(db.get("public_tables"))
                and db["public_tables"] > 0, "database_check_failed")
        inventory = request("/api/inventory/summary")
        require(isinstance(inventory.get("byType"), list) and isinstance(inventory.get("byCategory"), list)
                and nonnegative_integer(inventory.get("total")), "inventory_check_failed")
        reports = request("/api/diagnosis")
        require(isinstance(reports.get("reports"), list), "diagnosis_check_failed")
        return ["login", "me", "health", "db", "inventory_summary", "diagnosis"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="step", required=True)
    for name in ("preflight", "check-smoke", "preview-migrations", "migrate", "roll-web", "smoke"):
        sub.add_parser(name)
    build = sub.add_parser("record-build")
    build.add_argument("--digest", required=True)
    verify = sub.add_parser("verify-web")
    verify.add_argument("--timeout-seconds", type=int, default=600)
    verify.add_argument("--poll-seconds", type=int, default=10)
    args = parser.parse_args(argv)
    try:
        controller = Controller()
        if args.step == "record-build":
            state = controller.record_build(args.digest)
        elif args.step == "verify-web":
            state = controller.verify_web(args.timeout_seconds, args.poll_seconds)
        else:
            state = getattr(controller, args.step.replace("-", "_"))()
        summary = {"step": args.step, "status": "ok", "commit": controller.context["commit"]}
        if "build" in state:
            summary["image_digest"] = state["build"]["digest"]
        if "roll" in state:
            summary["deployment_id"] = state["roll"]["deployment_id"]
        print(json.dumps(summary, sort_keys=True))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, ReleaseError) else "unexpected_failure"
        if not re.fullmatch(r"[a-z_]+", code):
            code = "release_failed"
        print(json.dumps({"step": args.step, "status": "failed", "error": code}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
