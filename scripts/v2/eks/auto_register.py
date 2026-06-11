"""EKS auto-register — EventBridge(CloudTrail) → eks_registrations.

The v1 "Register kubeconfig" flow, fully automated for v2: when an operator runs the
onboarding CLI (create-access-entry + associate-access-policy) for the web task role,
CloudTrail emits the management event, EventBridge matches it, and this Lambda records
the cluster in Aurora `eks_registrations` — the BFF allow-list (env ∪ DB) picks it up on
the next read. DeleteAccessEntry symmetrically unregisters. READ-ONLY toward AWS: we
never create/modify AWS resources here — we only observe operator actions (ADR-029-safe).

Env: AURORA_ENDPOINT, AURORA_DATABASE, AURORA_SECRET_ARN, TASK_ROLE_NAME, AWS_REGION.
"""
import json
import os
import ssl
import urllib.parse

_secret_cache = {}


def parse_event(event, task_role_name):
    """Pure: extract (action, cluster) from a CloudTrail-via-EventBridge EKS event.

    Returns ("register"|"unregister", cluster) or (None, reason). Only events whose
    principalArn targets OUR task role count — other principals' entries are not ours.
    """
    detail = event.get("detail") or {}
    name = detail.get("eventName") or ""
    if detail.get("errorCode"):  # failed API calls must not register anything
        return None, f"errored call: {detail.get('errorCode')}"
    params = detail.get("requestParameters") or {}
    # EKS REST API: the cluster is the 'name' path param; principalArn may be URL-encoded.
    cluster = params.get("name") or params.get("clusterName") or ""
    principal = urllib.parse.unquote(params.get("principalArn") or "")
    if not cluster:
        return None, "no cluster in requestParameters"
    if not principal.endswith(f":role/{task_role_name}"):
        return None, f"principal is not {task_role_name}"
    if name == "AssociateAccessPolicy":
        return "register", cluster
    if name == "DeleteAccessEntry":
        return "unregister", cluster
    return None, f"unhandled event {name}"


def _creds():
    import boto3
    arn = os.environ["AURORA_SECRET_ARN"]
    if arn not in _secret_cache:
        sm = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
        _secret_cache[arn] = json.loads(sm.get_secret_value(SecretId=arn)["SecretString"])
    return _secret_cache[arn]


def _ssl_context():
    """Verified TLS to Aurora — PR #36 review MAJOR, implemented (not just TODO'd).

    This path is auto-triggered by EventBridge and WRITES the cluster allow-list, so a
    MITM on the Aurora hop could inject an arbitrary cluster into eks_registrations →
    the BFF would immediately proxy it. Unlike workers/db.py (job queue; different threat
    model), this connection REQUIRES cert verification: the regional RDS CA bundle
    (rds-ca-bundle.pem, truststore.pki.rds.amazonaws.com) ships in the Lambda zip and
    hostname checking stays on (pg8000 passes host as server_hostname).
    """
    bundle = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rds-ca-bundle.pem")
    ctx = ssl.create_default_context(cafile=bundle)
    # defaults with a cafile: verify_mode=CERT_REQUIRED, check_hostname=True — keep both.
    return ctx


def _connect():
    import pg8000.native
    c = _creds()
    return pg8000.native.Connection(
        user=c["username"], password=c["password"],
        host=os.environ["AURORA_ENDPOINT"], database=os.environ["AURORA_DATABASE"],
        port=5432, ssl_context=_ssl_context(),
    )


def handler(event, _ctx):
    action, cluster = parse_event(event, os.environ.get("TASK_ROLE_NAME", "awsops-v2-task"))
    if action is None:
        print(json.dumps({"evt": "eks_auto_register_skip", "reason": cluster}))
        return {"skipped": True, "reason": cluster}
    actor = ((event.get("detail") or {}).get("userIdentity") or {}).get("arn", "cloudtrail")
    conn = _connect()
    try:
        if action == "register":
            conn.run(
                "INSERT INTO eks_registrations (cluster_name, registered_by) VALUES (:c, :b) "
                "ON CONFLICT (cluster_name) DO NOTHING",
                c=cluster, b=f"eventbridge:{actor}",  # registered_by is TEXT — no truncation needed (PR #36 review)
            )
        else:
            conn.run("DELETE FROM eks_registrations WHERE cluster_name = :c", c=cluster)
    finally:
        conn.close()
    print(json.dumps({"evt": "eks_auto_register", "action": action, "cluster": cluster, "actor": actor}))
    return {"ok": True, "action": action, "cluster": cluster}
