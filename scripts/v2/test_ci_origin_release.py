"""Offline web acceptance tests: CLI, private executor and HTTPS boundaries are faked.

The private executor's AWS evidence checks have a separate adversarial suite.

Run: python3 -B -m unittest discover -s scripts/v2 -p test_ci_origin_release.py -v
"""
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from email.message import Message
from unittest.mock import patch
from urllib.response import addinfourl
from urllib.parse import urlsplit

import ci_origin_release as release


SHA = "a" * 40
ACCOUNT = "123456789012"
PROJECT = "awsops-v2"
REGION = "ap-northeast-2"
ORIGIN = "https://ops.example.test"
REPO = f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/{PROJECT}-web"
PREFIX = f"arn:aws:ecs:{REGION}:{ACCOUNT}:"
TASK_DEF = PREFIX + f"task-definition/{PROJECT}-web:17"
CLUSTER = PREFIX + f"cluster/{PROJECT}"
SERVICE = PREFIX + f"service/{PROJECT}/{PROJECT}-web"
OLD_ID = "ecs-svc/1000000000000000001"
NEW_ID = "ecs-svc/1000000000000000002"
OCI_IMAGE = "application/vnd.oci.image.manifest.v1+json"
OCI_INDEX = "application/vnd.oci.image.index.v1+json"
PASSWORD = "private-password-do-not-print"
COOKIE = "private-cookie-do-not-print"


def image(config_char):
    return json.dumps({
        "schemaVersion": 2, "mediaType": OCI_IMAGE,
        "config": {"mediaType": "application/vnd.oci.image.config.v1+json",
                   "digest": "sha256:" + config_char * 64, "size": 100},
        "layers": [{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                    "digest": "sha256:" + "d" * 64, "size": 100}],
    }, separators=(",", ":"))


def digest(raw):
    return "sha256:" + hashlib.sha256(raw.encode()).hexdigest()


ARM_RAW = image("a")
AMD_RAW = image("b")
ARM = digest(ARM_RAW)
AMD = digest(AMD_RAW)
INDEX_RAW = json.dumps({
    "schemaVersion": 2, "mediaType": OCI_INDEX,
    "manifests": [
        {"mediaType": OCI_IMAGE, "digest": AMD, "size": len(AMD_RAW),
         "platform": {"os": "linux", "architecture": "amd64"}},
        {"mediaType": OCI_IMAGE, "digest": ARM, "size": len(ARM_RAW),
         "platform": {"os": "linux", "architecture": "arm64", "variant": "v8"}},
        {"mediaType": OCI_IMAGE, "digest": "sha256:" + "c" * 64, "size": 1,
         "platform": {"os": "unknown", "architecture": "unknown"}},
    ],
}, separators=(",", ":"))
INDEX = digest(INDEX_RAW)


class FakeCLI:
    def __init__(self):
        self.calls = []
        self.head = SHA
        self.dirty = ""
        self.account = ACCOUNT
        self.repository = {"registryId": ACCOUNT, "repositoryName": PROJECT + "-web",
                           "repositoryUri": REPO}
        self.database = {
            "DBClusterArn": f"arn:aws:rds:{REGION}:{ACCOUNT}:cluster:{PROJECT}-aurora",
            "DBClusterIdentifier": PROJECT + "-aurora", "Status": "available",
            "DatabaseName": "awsops",
            "Endpoint": f"{PROJECT}-aurora.cluster-example.{REGION}.rds.amazonaws.com",
            "MasterUserSecret": {
                "SecretArn": f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:rds!cluster-example-Abc123",
                "SecretStatus": "active",
            },
        }
        self.service = {
            "serviceArn": SERVICE, "serviceName": PROJECT + "-web", "clusterArn": CLUSTER,
            "status": "ACTIVE", "taskDefinition": TASK_DEF,
            "desiredCount": 1, "runningCount": 1, "pendingCount": 0,
            "deploymentController": {"type": "ECS"},
            "deployments": [{"id": OLD_ID, "status": "PRIMARY", "taskDefinition": TASK_DEF,
                             "rolloutState": "COMPLETED", "desiredCount": 1,
                             "runningCount": 1, "pendingCount": 0}],
        }
        self.definition = {
            "taskDefinitionArn": TASK_DEF, "status": "ACTIVE",
            "runtimePlatform": {"cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX"},
            "containerDefinitions": [
                {"name": "web", "image": REPO + ":web-latest", "essential": True,
                 "environment": [{"name": "HOSTNAME", "value": "0.0.0.0"},
                                 {"name": "APP_DOMAIN", "value": urlsplit(ORIGIN).hostname},
                                 {"name": "AURORA_ENDPOINT", "value": self.database["Endpoint"]},
                                 {"name": "UNRELATED_CONFIG", "value": PASSWORD}],
                 "portMappings": [{"containerPort": 3000}],
                 "healthCheck": {"command": ["CMD-SHELL", "wget http://127.0.0.1:3000/api/health"]}},
                {"name": "sidecar", "image": "private-sidecar", "environment": [
                    {"name": "SIDE_SECRET", "value": PASSWORD}]},
            ],
        }
        self.manifests = {ARM: ARM_RAW, AMD: AMD_RAW, INDEX: INDEX_RAW}
        self.tags = {"web-" + SHA: INDEX, "web-latest": AMD}
        self.tasks = [{
            "taskArn": PREFIX + "task/" + PROJECT + "/" + "1" * 32,
            "clusterArn": CLUSTER, "taskDefinitionArn": TASK_DEF,
            "group": "service:" + PROJECT + "-web", "startedBy": NEW_ID,
            "lastStatus": "RUNNING", "desiredStatus": "RUNNING", "healthStatus": "HEALTHY",
            "containers": [{"name": "web", "image": REPO + ":web-latest",
                            "imageDigest": ARM, "lastStatus": "RUNNING", "healthStatus": "HEALTHY"}],
        }]
        self.migration_failure = False
        self.failures = []
        self.task_failures = []
        self.migration_context = None

    def __call__(self, argv, **kwargs):
        argv = list(argv)
        self.calls.append((argv, kwargs))
        if argv == ["git", "rev-parse", "HEAD"]:
            return self.head
        if argv == ["git", "status", "--porcelain", "--untracked-files=no"]:
            return self.dirty
        if argv == ["make", "migrate"]:
            self.migration_context = json.loads(Path(kwargs["env"]["CI_MIGRATION_CONTEXT"]).read_text())
            if self.migration_failure:
                raise release.ReleaseError("command_failed")
            return "migration output " + PASSWORD
        if argv[0] != "aws":
            raise AssertionError("Unexpected CLI executable")
        if argv[argv.index("--region") + 1] != REGION:
            raise AssertionError("Missing pinned AWS region")
        service, action = argv[1:3]
        if (service, action) == ("sts", "get-caller-identity"):
            result = {"Account": self.account, "Arn": "do-not-record-identity-config"}
        elif (service, action) == ("ecr", "describe-repositories"):
            result = {"repositories": [copy.deepcopy(self.repository)]}
        elif (service, action) == ("rds", "describe-db-clusters"):
            result = {"DBClusters": [copy.deepcopy(self.database)]}
        elif (service, action) == ("ecs", "describe-services"):
            result = {"services": [copy.deepcopy(self.service)], "failures": self.failures}
        elif (service, action) == ("ecs", "describe-task-definition"):
            result = {"taskDefinition": copy.deepcopy(self.definition)}
        elif (service, action) == ("ecr", "batch-get-image"):
            reference = argv[argv.index("--image-ids") + 1]
            key, value = reference.split("=", 1)
            image_digest = self.tags.get(value) if key == "imageTag" else value
            if image_digest not in self.manifests:
                return json.dumps({"images": [], "failures": [{"failureReason": PASSWORD}]})
            raw = self.manifests[image_digest]
            result = {"failures": [], "images": [{
                "registryId": ACCOUNT, "repositoryName": PROJECT + "-web",
                "imageId": {"imageDigest": image_digest, **({"imageTag": value} if key == "imageTag" else {})},
                "imageManifest": raw, "imageManifestMediaType": json.loads(raw)["mediaType"],
            }]}
        elif (service, action) == ("ecr", "put-image"):
            raw = argv[argv.index("--image-manifest") + 1]
            image_digest = digest(raw)
            if argv[argv.index("--image-tag") + 1] != "web-latest":
                raise AssertionError("Only promote the existing web-latest tag")
            self.tags["web-latest"] = image_digest
            result = {"image": {"imageId": {"imageDigest": image_digest, "imageTag": "web-latest"}}}
        elif (service, action) == ("ecs", "update-service"):
            if "--force-new-deployment" not in argv or "--task-definition" in argv:
                raise AssertionError("Only restart the existing web task definition")
            self.service["deployments"][0]["id"] = NEW_ID
            result = {"service": copy.deepcopy(self.service)}
        elif (service, action) == ("ecs", "list-tasks"):
            result = {"taskArns": [t["taskArn"] for t in self.tasks]}
        elif (service, action) == ("ecs", "describe-tasks"):
            requested = argv[argv.index("--tasks") + 1:argv.index("--region")]
            found = [t for t in self.tasks if t["taskArn"] in requested]
            missing = [{"arn": arn, "reason": "MISSING"} for arn in requested
                       if not any(t["taskArn"] == arn for t in found)]
            result = {"tasks": copy.deepcopy(found), "failures": self.task_failures or missing}
        else:
            raise AssertionError("Unexpected AWS operation: " + service + "/" + action)
        return json.dumps(result)

    def writes(self):
        return [argv for argv, _ in self.calls if argv[1:3] in (
            ["ecr", "put-image"], ["ecs", "update-service"])]


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.manifest = Path(self.temp.name) / "release.json"
        self.credentials = Path(self.temp.name) / "credentials.json"
        self.credentials.write_text(json.dumps({"email": "deploy@example.test", "password": PASSWORD}))
        self.credentials.chmod(0o600)
        self.cli = FakeCLI()
        env = {
            "CI_COMMIT_SHA": SHA, "CI_EXPECTED_ACCOUNT_ID": ACCOUNT,
            "CI_EXPECTED_PROJECT": PROJECT, "CI_EXPECTED_URL": ORIGIN,
            "CI_SQL_READER_SECRET_ARN": "disabled",
            "AWS_REGION": REGION, "CI_RELEASE_MANIFEST": str(self.manifest),
            "CI_SMOKE_CREDENTIAL_FILE": str(self.credentials), "TF_ROOT": "terraform/v2/foundation",
        }
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, env, clear=True).start()
        patch.object(release, "command", side_effect=self.cli).start()
        self.tick = 0
        patch.object(release.time, "monotonic", side_effect=lambda: self.tick).start()
        patch.object(release.time, "sleep", side_effect=self.advance).start()
        self.migration_patch = patch("ci_origin_migration.Migration")
        self.executor = self.migration_patch.start().return_value
        self.executor.target.side_effect = self.migration_target
        self.executor.verify_receipt.side_effect = self.migration_receipt
        self.http_calls = []
        self.http_override = {}
        patch("urllib.request.HTTPSHandler.https_open", new=self.transport).start()

    def advance(self, seconds):
        self.tick += seconds

    def migration_target(self):
        reader = os.environ["CI_SQL_READER_SECRET_ARN"]
        return {
            "version": 1, "commit": SHA, "account": ACCOUNT, "region": REGION, "project": PROJECT,
            "database": "awsops", "endpoint": self.cli.database["Endpoint"],
            "secret_arn": self.cli.database["MasterUserSecret"]["SecretArn"],
            "sql_reader_secret_arn": None if reader == "disabled" else reader,
        }

    def real_migration_target(self):
        """Exercise the shared helper unchanged, substituting only its CLI boundary."""
        self.migration_patch.stop()
        import ci_origin_migration as migration
        config = {
            "version": 1, "account": ACCOUNT, "region": REGION, "project": PROJECT,
            "subnets": ["subnet-0123456789abcdef0"], "security_group": "sg-0123456789abcdef0",
            "master_secret_arn": self.cli.database["MasterUserSecret"]["SecretArn"],
            "sql_reader_secret_arn": None,
            "task_role_arn": f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-ci-migration-task",
            "execution_role_arn": f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-ci-migration-execution",
            "log_group": f"/ecs/{PROJECT}-ci-migration",
        }
        os.environ["CI_MIGRATION_RECEIPT"] = str(Path(self.temp.name) / "migration.json")
        os.environ["CI_ROLE_ARN"] = f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-ci-release"

        def boundary(argv, **kwargs):
            if argv[:5] == ["git", "ls-files", "--others", "--exclude-standard", "--"]:
                self.assertEqual(tuple(argv[5:]), migration.BUILD_INPUTS)
                self.cli.calls.append((list(argv), kwargs))
                return ""
            result = self.cli(argv, **kwargs)
            if argv[:3] == ["aws", "sts", "get-caller-identity"]:
                caller = json.loads(result)
                caller["Arn"] = f"arn:aws:sts::{ACCOUNT}:assumed-role/{PROJECT}-ci-release/test"
                return json.dumps(caller)
            return result

        patch.object(migration, "command", side_effect=boundary).start()
        return config

    def migration_receipt(self, database, mode):
        self.cli.migration_context = copy.deepcopy(database)
        if self.cli.migration_failure:
            raise release.ReleaseError("migration_success_receipt_required")
        return {"mode": mode, "status": "succeeded"}

    def transport(self, req):
        self.http_calls.append(req)
        route = req.full_url.removeprefix(ORIGIN)
        responses = {
            "/api/auth/login": (200, {"ok": True, "redirect": "/"}, {
                "Set-Cookie": "awsops_token=" + COOKIE + "; Path=/; Secure; HttpOnly; SameSite=Lax"}),
            "/api/me": (200, {"sub": "verified-cognito-sub", "email": "deploy@example.test", "isAdmin": False}, {}),
            "/api/health": (200, {"status": "ok", "service": "awsops-web"}, {}),
            "/api/db": (200, {"status": "ok", "public_tables": 31}, {}),
            "/api/inventory/summary": (200, {"byType": [], "byCategory": [], "total": 0,
                                            "splits": {}, "ec2Types": [], "lastSyncAt": None,
                                            "collection": {}}, {}),
            "/api/diagnosis": (200, {"reports": []}, {}),
        }
        status_code, body, headers = self.http_override.get(route, responses.get(route, (404, {}, {})))
        message = Message()
        message["Content-Type"] = "application/json"
        for key, value in headers.items():
            message[key] = value
        response = addinfourl(io.BytesIO(json.dumps(body).encode()), message, req.full_url, status_code)
        response.msg = "fixture"
        return response

    def invoke(self, *args, ok=True):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = release.main(list(args))
        text = stdout.getvalue() + stderr.getvalue()
        self.assertNotIn(PASSWORD, text)
        self.assertNotIn(COOKIE, text)
        self.assertNotIn("deploy@example.test", text)
        self.assertEqual(code, 0 if ok else 1, text)
        return json.loads(stdout.getvalue())

    def state(self):
        return json.loads(self.manifest.read_text())

    def build(self):
        self.invoke("preflight")
        self.invoke("record-build", "--digest", INDEX)

    def roll(self):
        self.build()
        self.invoke("migrate")
        self.invoke("roll-web")

    def test_preflight_binds_source_scope_and_only_web_metadata(self):
        self.invoke("preflight")
        state = self.state()
        self.assertEqual(state["context"]["commit"], SHA)
        self.assertEqual(state["snapshot"]["primary_id"], OLD_ID)
        self.assertEqual(state["snapshot"]["task_definition"], TASK_DEF)
        self.assertEqual(state["snapshot"]["web"]["image"], REPO + ":web-latest")
        self.assertEqual(stat.S_IMODE(self.manifest.stat().st_mode), 0o600)
        self.assertNotIn(PASSWORD, self.manifest.read_text())
        self.assertNotIn("sidecar", self.manifest.read_text())
        self.assertEqual(self.cli.writes(), [])
        self.assertFalse(any(call[0][0] == "terraform" for call in self.cli.calls))

    def test_real_executor_reader_disagreement_rejects_preflight_before_any_writes(self):
        config = self.real_migration_target()
        reader = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:ops/{PROJECT}/agent/sql-reader-AbCd12"
        for declaration, configured in ((reader, None), ("disabled", reader)):
            with self.subTest(declaration=declaration, configured=configured):
                self.manifest.unlink(missing_ok=True)
                os.environ["CI_SQL_READER_SECRET_ARN"] = declaration
                config["sql_reader_secret_arn"] = configured
                os.environ["AWSOPS_MIGRATION_CONFIG_JSON"] = json.dumps(config)
                result = self.invoke("preflight", ok=False)
                self.assertEqual(result["error"], "migration_target_mismatch")
                self.assertFalse(self.manifest.exists())
                self.assertTrue(any(argv[:3] == ["aws", "rds", "describe-db-clusters"]
                                    and "--cli-input-json" in argv for argv, _ in self.cli.calls))
                self.assertEqual(self.cli.writes(), [])
                self.assertFalse(any(argv[1:3] in (["ecs", "run-task"], ["ecs", "register-task-definition"])
                                     for argv, _ in self.cli.calls))

    def test_real_executor_is_rechecked_before_preview_or_apply_launch(self):
        config = self.real_migration_target()
        reader = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:ops/{PROJECT}/agent/sql-reader-AbCd12"
        for mode in ("preview", "apply"):
            for declared in (None, reader):
                with self.subTest(mode=mode, declared=declared):
                    self.manifest.unlink(missing_ok=True)
                    self.cli.calls.clear()
                    os.environ["CI_SQL_READER_SECRET_ARN"] = declared or "disabled"
                    config["sql_reader_secret_arn"] = declared
                    os.environ["AWSOPS_MIGRATION_CONFIG_JSON"] = json.dumps(config)
                    self.invoke("preflight")
                    if mode == "apply":
                        self.invoke("record-build", "--digest", INDEX)
                    stage = self.state()["stage"]
                    self.invoke("check-executor")
                    config["sql_reader_secret_arn"] = reader if declared is None else None
                    os.environ["AWSOPS_MIGRATION_CONFIG_JSON"] = json.dumps(config)
                    result = self.invoke("check-executor", ok=False)
                    self.assertEqual(result["error"], "migration_target_mismatch")
                    self.assertEqual(self.state()["stage"], stage)
                    self.assertEqual(self.cli.writes(), [])
                    self.assertFalse(any(argv[1:3] in (["ecs", "run-task"], ["ecs", "register-task-definition"])
                                         for argv, _ in self.cli.calls))

    def test_smoke_rejects_effective_admin_authority_from_any_source(self):
        self.invoke("preflight")
        self.http_override["/api/me"] = (200, {
            "sub": "verified-cognito-sub", "email": "deploy@example.test", "isAdmin": True,
        }, {})
        self.invoke("check-smoke", ok=False)
        self.assertEqual(self.state()["stage"], "preflight")

    def test_dirty_tracked_source_is_rejected_before_preflight_reads(self):
        self.cli.dirty = " M scripts/v2/migrate.mjs"
        self.invoke("preflight", ok=False)
        self.assertFalse(self.manifest.exists())
        self.assertFalse(any(call[0][0] == "aws" for call in self.cli.calls))

    def test_preflight_emits_only_validated_single_line_workflow_outputs(self):
        output = Path(self.temp.name) / "github-output"
        with patch.dict(os.environ, {"GITHUB_OUTPUT": str(output)}):
            self.invoke("preflight")
        self.assertEqual(dict(line.split("=", 1) for line in output.read_text().splitlines()), {
            "repository_uri": REPO, "registry": REPO.split("/")[0],
            "cluster": PROJECT, "service": PROJECT + "-web", "public_url": ORIGIN,
        })
        self.assertNotIn(PASSWORD, output.read_text())
        self.assertNotIn("<<", output.read_text())

    def test_preflight_scope_failure_emits_no_workflow_outputs(self):
        output = Path(self.temp.name) / "github-output"
        self.cli.definition["containerDefinitions"][0]["environment"][1]["value"] = "wrong.example.test"
        with patch.dict(os.environ, {"GITHUB_OUTPUT": str(output)}):
            self.invoke("preflight", ok=False)
        self.assertFalse(output.exists())

    def test_wrong_head_account_resources_or_origin_prevents_preflight(self):
        for mutate in (
            lambda: setattr(self.cli, "head", "b" * 40),
            lambda: setattr(self.cli, "account", "999999999999"),
            lambda: self.cli.repository.update(repositoryUri=REPO.replace(PROJECT, "other")),
            lambda: self.cli.service.update(clusterArn=CLUSTER + "-other"),
            lambda: self.cli.service.update(serviceName="other-web"),
            lambda: self.cli.database.update(DBClusterArn=self.cli.database["DBClusterArn"] + "-other"),
        ):
            with self.subTest(mutate=mutate):
                self.cli.__init__()
                mutate()
                self.invoke("preflight", ok=False)
                self.assertFalse(self.manifest.exists())

    def test_missing_env_unsafe_origin_manifest_or_tf_root_fail_closed(self):
        cases = [
            ("CI_COMMIT_SHA", ""), ("CI_COMMIT_SHA", "short"), ("CI_EXPECTED_ACCOUNT_ID", ""),
            ("CI_EXPECTED_PROJECT", ""), ("AWS_REGION", ""),
            ("CI_EXPECTED_URL", "http://ops.example.test"),
            ("CI_EXPECTED_URL", "https://user:password@ops.example.test"),
            ("CI_EXPECTED_URL", ORIGIN + "/some/path"),
            ("CI_EXPECTED_URL", ORIGIN + "?redirect=elsewhere"),
            ("CI_RELEASE_MANIFEST", "relative.json"), ("TF_ROOT", "terraform/foundation"),
        ]
        for key, value in cases:
            with self.subTest(key=key, value=value), patch.dict(os.environ, {key: value}):
                self.invoke("preflight", ok=False)
        self.assertFalse(self.manifest.exists())

    def test_preflight_rejects_missing_health_configuration_or_wrong_architecture(self):
        for field, value in (("cpuArchitecture", "X86_64"), ("operatingSystemFamily", "WINDOWS_SERVER_2022_CORE")):
            with self.subTest(field=field):
                self.cli.definition["runtimePlatform"][field] = value
                self.invoke("preflight", ok=False)
                self.cli.__init__()
        self.cli.definition["containerDefinitions"][0].pop("healthCheck")
        self.invoke("preflight", ok=False)
        self.assertEqual(self.cli.writes(), [])

    def test_snapshot_accepts_transient_old_health_without_waiting(self):
        reads = 0
        def changing(argv, **kwargs):
            nonlocal reads
            result = self.cli(argv, **kwargs)
            if argv[1:3] == ["ecs", "describe-services"]:
                reads += 1
                if reads == 1:
                    value = json.loads(result)
                    value["services"][0]["pendingCount"] = 1
                    return json.dumps(value)
            return result
        with patch.object(release, "command", side_effect=changing):
            self.invoke("preflight")
        self.assertGreaterEqual(reads, 1)
        self.assertEqual(self.tick, 0)
        self.assertEqual(self.state()["snapshot"]["primary_id"], OLD_ID)
        self.assertEqual(self.cli.writes(), [])

    def test_prior_failed_health_does_not_block_preflight(self):
        self.cli.service["pendingCount"] = 1
        self.cli.service["deployments"][0]["rolloutState"] = "FAILED"
        self.cli.tasks[0]["healthStatus"] = "UNHEALTHY"
        self.cli.tasks[0]["containers"][0]["imageDigest"] = AMD
        self.invoke("preflight")
        self.assertEqual(self.tick, 0)
        self.assertEqual(self.state()["stage"], "preflight")
        self.assertEqual(self.cli.writes(), [])

    def test_empty_failed_service_is_probed_then_recovers_with_one_update(self):
        candidate = copy.deepcopy(self.cli.tasks[0])
        self.cli.tasks.clear()
        self.cli.service.update(runningCount=0, pendingCount=0)
        self.cli.service["deployments"][0].update(rolloutState="FAILED", runningCount=0, pendingCount=0)
        def recovering(argv, **kwargs):
            if argv[1:3] == ["ecs", "update-service"]:
                self.cli.service.update(runningCount=1, pendingCount=0)
                self.cli.service["deployments"][0].update(rolloutState="COMPLETED", runningCount=1, pendingCount=0)
                self.cli.tasks = [candidate]
            return self.cli(argv, **kwargs)
        with patch.object(release, "command", side_effect=recovering):
            self.roll()
            self.invoke("verify-web")
            self.invoke("smoke")
        self.assertEqual(self.state()["stage"], "smoked")
        update = next(i for i, (a, _) in enumerate(self.cli.calls) if a[1:3] == ["ecs", "update-service"])
        probe = next(a for a, _ in self.cli.calls[:update] if a[1:3] == ["ecs", "describe-tasks"])
        self.assertRegex(probe[probe.index("--tasks") + 1], "^" + PREFIX + "task/" + PROJECT + "/[a-f0-9]{32}$")
        self.assertEqual([a[1:3] for a in self.cli.writes()],
                         [["ecr", "put-image"], ["ecs", "update-service"]])

    def test_empty_service_still_requires_describe_tasks_permission(self):
        self.cli.tasks.clear()
        self.cli.service.update(runningCount=0, pendingCount=0)
        self.cli.service["deployments"][0].update(rolloutState="FAILED", runningCount=0, pendingCount=0)
        probes = []
        def denied(argv, **kwargs):
            if argv[1:3] == ["ecs", "describe-tasks"]:
                probes.append(argv)
                raise release.ReleaseError("command_failed")
            return self.cli(argv, **kwargs)
        with patch.object(release, "command", side_effect=denied):
            result = self.invoke("preflight", ok=False)
        self.assertEqual(result["error"], "command_failed")
        self.assertEqual(len(probes), 1)
        self.assertEqual(self.cli.writes(), [])

    def test_paused_service_cannot_be_reactivated(self):
        self.cli.service.update(desiredCount=0, runningCount=0, pendingCount=0)
        self.cli.service["deployments"][0].update(desiredCount=0, runningCount=0, pendingCount=0)
        self.cli.tasks.clear()
        self.invoke("preflight", ok=False)
        self.assertEqual(self.tick, 0)
        self.assertEqual(self.cli.writes(), [])

    def test_malformed_snapshot_counts_are_not_retryable(self):
        self.cli.service["deployments"][0]["runningCount"] = "1"
        self.invoke("preflight", ok=False)
        self.assertEqual(self.tick, 0)
        self.assertEqual(self.cli.writes(), [])

    def test_build_resolves_only_linux_arm64_child_from_content_verified_index(self):
        self.build()
        build = self.state()["build"]
        self.assertEqual(build["digest"], INDEX)
        self.assertEqual(build["arm64_digest"], ARM)
        self.assertNotIn(AMD, json.dumps(build))
        self.assertEqual(self.cli.writes(), [])

    def test_build_digest_tag_or_manifest_content_mismatch_is_rejected(self):
        self.invoke("preflight")
        self.invoke("record-build", "--digest", "sha256:" + "0" * 64, ok=False)
        self.cli.manifests[INDEX] = INDEX_RAW + " "
        self.invoke("record-build", "--digest", INDEX, ok=False)
        self.assertNotIn("build", self.state())

    def test_single_platform_manifest_is_supported(self):
        self.cli.tags["web-" + SHA] = ARM
        self.invoke("preflight")
        self.invoke("record-build", "--digest", ARM)
        self.assertEqual(self.state()["build"]["arm64_digest"], ARM)

    def test_child_manifest_must_exist_and_match_its_digest(self):
        self.invoke("preflight")
        self.cli.manifests[ARM] = AMD_RAW
        self.invoke("record-build", "--digest", INDEX, ok=False)
        self.assertNotIn("build", self.state())

    def test_index_requires_one_unambiguous_linux_arm64_child(self):
        original = json.loads(INDEX_RAW)
        for children in (
            [original["manifests"][0]],
            [original["manifests"][1], original["manifests"][1]],
            [{**original["manifests"][1], "platform": {"os": "windows", "architecture": "arm64"}}],
        ):
            with self.subTest(children=children):
                self.cli.__init__()
                self.manifest.unlink(missing_ok=True)
                raw = json.dumps({**original, "manifests": children}, separators=(",", ":"))
                image_digest = digest(raw)
                self.cli.manifests[image_digest] = raw
                self.cli.tags["web-" + SHA] = image_digest
                self.invoke("preflight")
                self.invoke("record-build", "--digest", image_digest, ok=False)
                self.assertNotIn("build", self.state())

    def test_migration_proof_only_written_after_success_and_roll_requires_it(self):
        self.build()
        self.invoke("roll-web", ok=False)
        self.assertEqual(self.cli.writes(), [])
        self.cli.migration_failure = True
        self.invoke("migrate", ok=False)
        self.assertNotIn("migration", self.state())
        self.invoke("roll-web", ok=False)
        self.cli.migration_failure = False
        self.invoke("migrate")
        self.assertEqual(self.state()["migration"]["commit"], SHA)
        self.assertEqual(self.state()["migration"]["status"], "succeeded")
        self.assertEqual(self.cli.migration_context["endpoint"], self.cli.database["Endpoint"])
        self.assertNotIn("password", self.cli.migration_context)

    def test_private_migration_preview_cannot_create_deployment_or_migration_proof(self):
        self.invoke("preflight")
        before = self.manifest.read_bytes()
        self.invoke("preview-migrations")
        self.assertEqual(self.manifest.read_bytes(), before)
        self.assertEqual(self.executor.verify_receipt.call_args.args[1], "preview")
        self.assertFalse(any(argv == ["make", "migrate"] for argv, _ in self.cli.calls))
        self.assertEqual(self.cli.writes(), [])

    def test_migration_dry_run_or_make_override_cannot_mint_proof(self):
        self.build()
        for key, value in (("DRY_RUN", "1"), ("STATUS", "1"), ("OFFLINE", "1"),
                           ("BOOTSTRAP", "1"), ("MAKEFLAGS", "--just-print"), ("MAKEFILES", "/tmp/other.mk")):
            with self.subTest(key=key), patch.dict(os.environ, {key: value}):
                self.invoke("migrate", ok=False)
        self.assertNotIn("migration", self.state())

    def test_changed_commit_cannot_reuse_proof(self):
        self.build()
        self.invoke("migrate")
        self.cli.head = "b" * 40
        with patch.dict(os.environ, {"CI_COMMIT_SHA": "b" * 40}):
            self.invoke("roll-web", ok=False)
        self.assertEqual(self.cli.writes(), [])

    def test_checkout_moving_during_migration_cannot_mint_success_proof(self):
        self.build()

        def moved(database, mode):
            result = self.migration_receipt(database, mode)
            self.cli.head = "b" * 40
            return result

        with patch.object(self.executor, "verify_receipt", side_effect=moved):
            self.invoke("migrate", ok=False)
        self.assertNotIn("migration", self.state())

    def test_service_movement_or_retagging_prevents_any_promotion(self):
        for mutation in (
            lambda: self.cli.service["deployments"][0].update(id=NEW_ID),
            lambda: self.cli.service.update(taskDefinition=TASK_DEF.replace(":17", ":18")),
            lambda: self.cli.service.update(desiredCount=2),
            lambda: self.cli.tags.update({"web-" + SHA: AMD}),
        ):
            with self.subTest(mutation=mutation):
                self.cli.__init__()
                self.manifest.unlink(missing_ok=True)
                self.build()
                self.invoke("migrate")
                mutation()
                self.invoke("roll-web", ok=False)
                self.assertEqual(self.cli.writes(), [])

    def test_roll_promotes_digest_and_records_exact_returned_deployment(self):
        self.roll()
        self.assertEqual(self.cli.tags["web-latest"], INDEX)
        self.assertEqual(self.state()["roll"]["deployment_id"], NEW_ID)
        self.assertEqual(self.state()["roll"]["digest"], INDEX)
        self.assertEqual([a[1:3] for a in self.cli.writes()],
                         [["ecr", "put-image"], ["ecs", "update-service"]])
        for argv, options in self.cli.calls:
            if argv[1:3] in (["ecr", "put-image"], ["ecs", "update-service"]):
                self.assertEqual(options.get("env", {}).get("AWS_MAX_ATTEMPTS"), "1",
                                 "The AWS CLI must not retry mutations behind the controller")

    def test_stale_update_primary_is_reconciled_without_repeating_mutations(self):
        self.build()
        self.invoke("migrate")
        old = copy.deepcopy(self.cli.service)
        def accepted(argv, **kwargs):
            if argv[1:3] == ["ecs", "update-service"]:
                self.assertEqual(self.state()["stage"], "rolling")
                self.assertEqual(self.state()["intent"]["digest"], INDEX)
                self.cli(argv, **kwargs)  # AWS accepted the request, response is stale.
                return json.dumps({"service": old})
            return self.cli(argv, **kwargs)
        with patch.object(release, "command", side_effect=accepted):
            self.invoke("roll-web")
        self.assertGreater(self.tick, 0)
        self.assertEqual(self.state()["roll"]["deployment_id"], NEW_ID)
        self.assertEqual([a[1:3] for a in self.cli.writes()],
                         [["ecr", "put-image"], ["ecs", "update-service"]])

    def test_lost_update_response_leaves_intent_and_resume_is_read_only(self):
        self.build()
        self.invoke("migrate")
        def lost(argv, **kwargs):
            result = self.cli(argv, **kwargs)
            if argv[1:3] == ["ecs", "update-service"]:
                self.assertEqual(self.state()["stage"], "rolling")
                raise release.ReleaseError("command_timeout")
            return result
        with patch.object(release, "command", side_effect=lost):
            result = self.invoke("roll-web", ok=False)
        self.assertEqual(result["error"], "command_timeout")
        self.assertEqual(self.tick, 0, "Do not retry an API error automatically")
        self.assertEqual(self.state()["stage"], "rolling")
        self.assertNotIn("roll", self.state())
        writes = copy.deepcopy(self.cli.writes())
        self.invoke("roll-web")
        self.assertEqual(self.cli.writes(), writes)
        self.assertEqual(self.state()["roll"]["deployment_id"], NEW_ID)

    def test_persistent_old_primary_after_update_times_out_with_intent(self):
        self.build()
        self.invoke("migrate")
        old = copy.deepcopy(self.cli.service)
        def unchanged(argv, **kwargs):
            result = self.cli(argv, **kwargs)
            if argv[1:3] == ["ecs", "update-service"]:
                self.cli.service = copy.deepcopy(old)
                return json.dumps({"service": old})
            return result
        with patch.object(release, "command", side_effect=unchanged):
            result = self.invoke("roll-web", ok=False)
        self.assertEqual(result["error"], "verification_timeout")
        self.assertEqual(self.tick, 120)
        self.assertEqual(self.state()["stage"], "rolling")
        self.assertNotIn("roll", self.state())
        writes = copy.deepcopy(self.cli.writes())
        self.invoke("roll-web", ok=False)
        self.assertEqual(self.cli.writes(), writes)

    def test_malformed_update_identity_is_immediate_and_retains_intent(self):
        self.build()
        self.invoke("migrate")
        def malformed(argv, **kwargs):
            result = self.cli(argv, **kwargs)
            if argv[1:3] == ["ecs", "update-service"]:
                value = json.loads(result)
                value["service"]["serviceArn"] = SERVICE.replace(PROJECT, "other")
                return json.dumps(value)
            return result
        with patch.object(release, "command", side_effect=malformed):
            self.invoke("roll-web", ok=False)
        self.assertEqual(self.tick, 0)
        self.assertEqual(self.state()["stage"], "rolling")
        self.assertNotIn("roll", self.state())
        self.assertEqual(len(self.cli.writes()), 2)

    def test_intent_write_failure_prevents_update(self):
        self.build()
        self.invoke("migrate")
        original = release.Controller.save
        def failed(controller, state):
            if state["stage"] == "rolling":
                raise release.ReleaseError("manifest_write_failed")
            return original(controller, state)
        with patch.object(release.Controller, "save", new=failed):
            self.invoke("roll-web", ok=False)
        self.assertFalse(any(a[1:3] == ["ecs", "update-service"] for a in self.cli.writes()))

    def test_service_movement_during_tag_promotion_prevents_ecs_update(self):
        self.build()
        self.invoke("migrate")

        def moved(argv, **kwargs):
            result = self.cli(argv, **kwargs)
            if argv[1:3] == ["ecr", "put-image"]:
                self.cli.service["deployments"][0]["id"] = NEW_ID
            return result

        with patch.object(release, "command", side_effect=moved):
            self.invoke("roll-web", ok=False)
        self.assertEqual([a[1:3] for a in self.cli.writes()], [["ecr", "put-image"]])
        self.assertNotIn("roll", self.state())

    def test_verify_accepts_index_or_arm64_digest_but_not_other_child(self):
        for actual, ok in ((INDEX, True), (ARM, True), (AMD, False)):
            with self.subTest(actual=actual):
                self.cli.__init__()
                self.manifest.unlink(missing_ok=True)
                self.roll()
                self.cli.tasks[0]["containers"][0]["imageDigest"] = actual
                self.invoke("verify-web", ok=ok)
                self.assertEqual("verified" in self.state(), ok)

    def test_verify_rejects_rollback_even_if_old_service_is_healthy(self):
        self.roll()
        self.cli.service["deployments"][0]["id"] = OLD_ID
        result = self.invoke("verify-web", "--timeout-seconds", "20", ok=False)
        self.assertEqual(result["error"], "verification_timeout")
        self.assertEqual(self.tick, 20)
        self.assertNotIn("verified", self.state())

    def test_verify_retries_stale_primary_listing_description_and_health(self):
        scenarios = ("primary", "counts", "listing", "missing", "old_task", "health", "digest")
        for scenario in scenarios:
            with self.subTest(scenario=scenario):
                self.cli.__init__()
                self.manifest.unlink(missing_ok=True)
                self.tick = 0
                self.roll()
                reads = 0
                operation = ("describe-services" if scenario in ("primary", "counts")
                             else "list-tasks" if scenario == "listing" else "describe-tasks")
                def eventual(argv, **kwargs):
                    nonlocal reads
                    result = self.cli(argv, **kwargs)
                    if argv[1:3] == ["ecs", operation]:
                        reads += 1
                        if reads == 1:
                            value = json.loads(result)
                            if scenario == "primary":
                                value["services"][0]["deployments"][0]["id"] = OLD_ID
                            elif scenario == "counts":
                                value["services"][0]["pendingCount"] = 1
                            elif scenario == "listing":
                                value["taskArns"] = []
                            elif scenario == "missing":
                                value = {"tasks": [], "failures": [
                                    {"arn": self.cli.tasks[0]["taskArn"], "reason": "MISSING"}]}
                            elif scenario == "old_task":
                                value["tasks"][0]["startedBy"] = OLD_ID
                            elif scenario == "health":
                                value["tasks"][0]["containers"][0]["healthStatus"] = "UNKNOWN"
                            else:
                                value["tasks"][0]["containers"][0]["imageDigest"] = AMD
                            return json.dumps(value)
                    return result
                with patch.object(release, "command", side_effect=eventual):
                    self.invoke("verify-web", "--timeout-seconds", "30", "--poll-seconds", "5")
                self.assertGreaterEqual(reads, 2)
                self.assertEqual(self.tick, 5)
                self.assertEqual(self.state()["stage"], "verified")
                self.assertEqual(len(self.cli.writes()), 2)

    def test_persistent_wrong_digest_cannot_mint_verified_state(self):
        self.roll()
        self.cli.tasks[0]["containers"][0]["imageDigest"] = AMD
        result = self.invoke("verify-web", "--timeout-seconds", "12", "--poll-seconds", "5", ok=False)
        self.assertEqual(result["error"], "verification_timeout")
        self.assertEqual(self.tick, 12)
        self.assertNotIn("verified", self.state())
        self.assertEqual(len(self.cli.writes()), 2)

    def test_foreign_task_and_denied_api_are_immediate_failures(self):
        self.roll()
        original = copy.deepcopy(self.cli.tasks[0])
        for field, value in (("clusterArn", CLUSTER + "-foreign"),
                             ("taskDefinitionArn", TASK_DEF.replace(PROJECT, "other")),
                             ("startedBy", "malformed")):
            with self.subTest(field=field):
                self.cli.tasks[0] = copy.deepcopy(original)
                self.cli.tasks[0][field] = value
                self.invoke("verify-web", ok=False)
                self.assertEqual(self.tick, 0)
        self.cli.tasks[0] = original
        def denied(argv, **kwargs):
            if argv[1:3] == ["ecs", "describe-tasks"]:
                raise release.ReleaseError("command_failed")
            return self.cli(argv, **kwargs)
        with patch.object(release, "command", side_effect=denied):
            result = self.invoke("verify-web", ok=False)
        self.assertEqual(result["error"], "command_failed")
        self.assertEqual(self.tick, 0)

    def test_read_timeout_uses_remaining_poll_budget(self):
        self.roll()
        reads = []
        def consume(argv, **kwargs):
            if argv[1:3] == ["ecs", "describe-services"]:
                reads.append(kwargs["timeout"])
                self.tick += 4
                result = json.loads(self.cli(argv, **kwargs))
                result["services"][0]["deployments"][0]["id"] = OLD_ID
                return json.dumps(result)
            return self.cli(argv, **kwargs)
        with patch.object(release, "command", side_effect=consume):
            self.invoke("verify-web", "--timeout-seconds", "12", "--poll-seconds", "5", ok=False)
        self.assertEqual(reads, [12, 3])
        self.assertNotIn("verified", self.state())

    def test_verify_requires_completed_deployment_and_all_running_tasks_healthy(self):
        for mutation in (
            lambda: self.cli.service["deployments"][0].update(rolloutState="FAILED"),
            lambda: self.cli.service["deployments"][0].pop("rolloutState"),
            lambda: self.cli.tasks[0].update(startedBy=OLD_ID),
            lambda: self.cli.tasks[0].update(healthStatus="UNKNOWN"),
            lambda: self.cli.tasks[0]["containers"][0].update(healthStatus="UNHEALTHY"),
            lambda: self.cli.tasks.clear(),
            lambda: self.cli.task_failures.append({"reason": PASSWORD}),
            lambda: self.cli.tags.update({"web-latest": AMD}),
        ):
            with self.subTest(mutation=mutation):
                self.cli.__init__()
                self.manifest.unlink(missing_ok=True)
                self.roll()
                mutation()
                self.invoke("verify-web", ok=False)
                self.assertNotIn("verified", self.state())

    def test_verify_wait_is_bounded(self):
        self.roll()
        self.cli.service["deployments"][0]["rolloutState"] = "IN_PROGRESS"
        self.invoke("verify-web", "--timeout-seconds", "1", "--poll-seconds", "1", ok=False)
        self.assertNotIn("verified", self.state())

    def test_task_pagination_uses_supported_cli_json_inputs_and_checks_every_page(self):
        self.cli.service.update(desiredCount=2, runningCount=2)
        self.cli.service["deployments"][0].update(desiredCount=2, runningCount=2)
        other = copy.deepcopy(self.cli.tasks[0])
        other["taskArn"] = PREFIX + "task/" + PROJECT + "/" + "2" * 32
        self.cli.tasks.append(other)
        self.roll()
        pages = []

        def paged(argv, **kwargs):
            if argv[1:3] == ["ecs", "list-tasks"]:
                # ECS CLI hides API maxResults/nextToken options. Raw bounded API
                # pagination is supplied through --cli-input-json + --no-paginate.
                self.assertIn("--cli-input-json", argv)
                self.assertIn("--no-paginate", argv)
                self.assertNotIn("--max-results", argv)
                self.assertNotIn("--next-token", argv)
                params = json.loads(argv[argv.index("--cli-input-json") + 1])
                self.assertEqual(params["cluster"], PROJECT)
                self.assertEqual(params["serviceName"], PROJECT + "-web")
                self.assertEqual(params["desiredStatus"], "RUNNING")
                self.assertEqual(params["maxResults"], 100)
                pages.append(params.get("nextToken"))
                if params.get("nextToken") == "second-page":
                    return json.dumps({"taskArns": [other["taskArn"]]})
                return json.dumps({"taskArns": [self.cli.tasks[0]["taskArn"]], "nextToken": "second-page"})
            return self.cli(argv, **kwargs)

        with patch.object(release, "command", side_effect=paged):
            self.invoke("verify-web")
        self.assertEqual(pages, [None, "second-page"])
        self.assertEqual(self.state()["verified"]["task_count"], 2)

    def test_service_api_failures_do_not_become_empty_success(self):
        self.cli.failures = [{"reason": PASSWORD}]
        self.invoke("preflight", ok=False)
        self.assertFalse(self.manifest.exists())

    def prepare_smoke(self):
        self.roll()
        self.invoke("verify-web")

    def test_smoke_uses_real_cookie_jar_and_validates_authenticated_db_core_reads(self):
        self.prepare_smoke()
        self.invoke("smoke")
        routes = [r.full_url.removeprefix(ORIGIN) for r in self.http_calls]
        self.assertIn("/api/me", routes)
        self.assertIn("/api/db", routes)
        self.assertIn("/api/inventory/summary", routes)
        self.assertIn("/api/diagnosis", routes)
        login = next(r for r in self.http_calls if r.full_url.endswith("/api/auth/login"))
        self.assertEqual(json.loads(login.data)["password"], PASSWORD)
        for req in self.http_calls:
            if req.full_url.endswith(("/api/me", "/api/db", "/api/inventory/summary", "/api/diagnosis")):
                self.assertIn(COOKIE, req.get_header("Cookie", ""))
        self.assertEqual(self.state()["stage"], "smoked")
        self.assertNotIn(PASSWORD, self.manifest.read_text())
        self.assertNotIn(COOKIE, self.manifest.read_text())

    def test_smoke_cannot_run_before_runtime_verification(self):
        self.roll()
        self.invoke("smoke", ok=False)
        self.assertEqual(self.http_calls, [])

    def test_smoke_requires_recorded_runtime_digest_checks(self):
        self.prepare_smoke()
        state = self.state()
        state["verified"].pop("runtime_digests")
        self.manifest.write_text(json.dumps(state))
        self.invoke("smoke", ok=False)
        self.assertEqual(self.http_calls, [])

    def test_check_smoke_after_preflight_runs_http_without_deployment_proofs_or_mutations(self):
        self.invoke("preflight")
        original = self.manifest.read_bytes()
        self.cli.calls.clear()
        self.invoke("check-smoke")
        self.assertEqual(self.manifest.read_bytes(), original)
        self.assertEqual(self.state()["stage"], "preflight")
        self.assertEqual(self.cli.writes(), [])
        self.assertFalse(any(argv[0] in ("aws", "terraform", "make") for argv, _ in self.cli.calls))
        self.assertTrue(any(r.full_url.endswith("/api/db") for r in self.http_calls))
        for field in ("build", "migration", "roll", "verified", "smoke"):
            self.assertNotIn(field, self.state())

    def test_check_smoke_requires_preflight_and_auth_success(self):
        self.invoke("check-smoke", ok=False)
        self.assertEqual(self.http_calls, [])
        self.invoke("preflight")
        self.http_override["/api/auth/login"] = (401, {"error": PASSWORD}, {})
        self.invoke("check-smoke", ok=False)
        self.assertEqual(self.state()["stage"], "preflight")

    def test_auth_failure_missing_cookie_or_wrong_identity_fails_without_leaking(self):
        cases = [
            ("/api/auth/login", (401, {"message": PASSWORD}, {})),
            ("/api/auth/login", (200, {"ok": True, "redirect": "/"}, {})),
            ("/api/me", (401, {"error": PASSWORD}, {})),
            ("/api/me", (200, {"sub": "other", "email": "other@example.test"}, {})),
        ]
        for route, response in cases:
            with self.subTest(route=route, response=response[0]):
                self.cli.__init__()
                self.manifest.unlink(missing_ok=True)
                self.prepare_smoke()
                self.http_override = {route: response}
                self.invoke("smoke", ok=False)
                self.assertNotIn("smoke", self.state())

    def test_off_origin_http_or_login_json_redirect_is_never_followed(self):
        for response in (
            (302, {}, {"Location": "https://evil.example.test/steal"}),
            (307, {}, {"Location": "https://evil.example.test/steal"}),
            (200, {"ok": True, "redirect": "https://evil.example.test/steal"},
             {"Set-Cookie": "awsops_token=" + COOKIE + "; Path=/; Secure"}),
        ):
            with self.subTest(status=response[0]):
                self.cli.__init__()
                self.manifest.unlink(missing_ok=True)
                self.prepare_smoke()
                self.http_calls.clear()
                self.http_override = {"/api/auth/login": response}
                self.invoke("smoke", ok=False)
                self.assertTrue(all(r.full_url.startswith(ORIGIN + "/") for r in self.http_calls))
                self.assertEqual(len(self.http_calls), 1)

    def test_db_or_core_error_including_200_error_payload_fails_smoke(self):
        for path, reply in (
            ("/api/db", {"status": "unconfigured"}),
            ("/api/db", {"status": "ok", "public_tables": 0}),
            ("/api/inventory/summary", {"status": "error", "message": PASSWORD}),
            ("/api/diagnosis", {"status": "error", "message": PASSWORD}),
        ):
            with self.subTest(path=path):
                self.cli.__init__()
                self.manifest.unlink(missing_ok=True)
                self.prepare_smoke()
                self.http_override = {path: (200, reply, {})}
                self.invoke("smoke", ok=False)
                self.assertNotIn("smoke", self.state())

    def test_smoke_credentials_must_be_private_regular_file(self):
        self.prepare_smoke()
        self.credentials.chmod(0o644)
        self.invoke("smoke", ok=False)
        self.credentials.chmod(0o600)
        symlink = Path(self.temp.name) / "symlink.json"
        symlink.symlink_to(self.credentials)
        with patch.dict(os.environ, {"CI_SMOKE_CREDENTIAL_FILE": str(symlink)}):
            self.invoke("smoke", ok=False)
        self.assertEqual(self.http_calls, [])

    def test_existing_manifest_or_wrong_commit_migration_cannot_be_reused(self):
        self.build()
        self.invoke("preflight", ok=False)
        self.invoke("migrate")
        state = self.state()
        state["migration"]["commit"] = "b" * 40
        self.manifest.write_text(json.dumps(state))
        self.invoke("roll-web", ok=False)
        self.assertEqual(self.cli.writes(), [])

    def test_unexpected_exceptions_are_sanitized(self):
        with patch.object(release, "command", side_effect=RuntimeError(PASSWORD + COOKIE)):
            self.invoke("preflight", ok=False)


class CommandTests(unittest.TestCase):
    def test_command_captures_output_uses_argv_and_drops_raw_failure(self):
        process = unittest.mock.Mock()
        process.communicate.return_value = (PASSWORD, COOKIE)
        process.returncode = 1
        with patch.object(release.subprocess, "Popen", return_value=process) as popen:
            with self.assertRaises(release.ReleaseError) as error:
                release.command(["aws", "sts", "get-caller-identity"])
        self.assertNotIn(PASSWORD, str(error.exception))
        self.assertNotIn(COOKIE, str(error.exception))
        self.assertEqual(popen.call_args.args[0], ["aws", "sts", "get-caller-identity"])
        self.assertFalse(popen.call_args.kwargs.get("shell", False))
        self.assertEqual(popen.call_args.kwargs["stdout"], subprocess.PIPE)
        self.assertEqual(popen.call_args.kwargs["stderr"], subprocess.PIPE)

    def test_timeout_terminates_process_group_without_printing_output(self):
        process = unittest.mock.Mock(pid=12345)
        process.communicate.side_effect = [subprocess.TimeoutExpired(["make"], 1, output=PASSWORD), ("", "")]
        with patch.object(release.subprocess, "Popen", return_value=process), patch.object(release.os, "killpg") as kill:
            with self.assertRaises(release.ReleaseError):
                release.command(["make", "migrate"], timeout=1)
        kill.assert_called_once()
        self.assertEqual(kill.call_args.args[0], 12345)

    def test_timeout_cleanup_is_bounded_even_if_a_detached_child_keeps_pipes_open(self):
        process = unittest.mock.Mock(pid=12345)
        process.communicate.side_effect = subprocess.TimeoutExpired(["make"], 1, output=PASSWORD)
        with patch.object(release.subprocess, "Popen", return_value=process), patch.object(release.os, "killpg"):
            with self.assertRaises(release.ReleaseError):
                release.command(["make", "migrate"], timeout=1)
        self.assertTrue(all(call.kwargs.get("timeout", 0) > 0 for call in process.communicate.call_args_list))


if __name__ == "__main__":
    unittest.main()
