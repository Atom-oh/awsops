"""D1 inventory sync: query the warm Steampipe FDW, UPSERT per-resource rows into Aurora.
Invoked by EventBridge (scheduled) and by the BFF /refresh (lambda:InvokeFunction). One sync
implementation. Advisory-locked per (resource_type) so concurrent triggers don't stampede Steampipe.
Env: STEAMPIPE_HOST, STEAMPIPE_SECRET_ARN (db password), AURORA_ENDPOINT, AURORA_DATABASE,
AURORA_SECRET_ARN, AWS_REGION."""
import json
import os
import ssl
import boto3
import pg8000.native

# resource_type -> (steampipe SQL, resource_id column, region column). Waves add rows here.
QUERIES = {
    "ec2": (
        "SELECT instance_id, instance_type, instance_state, region, account_id, "
        "private_ip_address, public_ip_address, vpc_id, launch_time "
        "FROM aws_ec2_instance ORDER BY launch_time DESC",
        "instance_id",
        "region",
    ),
    "s3": (
        "SELECT name, region, account_id, creation_date, versioning_enabled, bucket_policy_is_public "
        "FROM aws_s3_bucket ORDER BY creation_date DESC",
        "name",
        "region",
    ),
    "lambda": (
        "SELECT name, region, account_id, runtime, memory_size, timeout, last_modified, state, package_type "
        "FROM aws_lambda_function ORDER BY name",
        "name",
        "region",
    ),
    "rds": (
        "SELECT db_instance_identifier, region, account_id, engine, engine_version, class, status, "
        "multi_az, allocated_storage "
        "FROM aws_rds_db_instance ORDER BY db_instance_identifier",
        "db_instance_identifier",
        "region",
    ),
    "ebs_volume": (
        "SELECT volume_id, region, account_id, volume_type, size, state, encrypted, availability_zone "
        "FROM aws_ebs_volume ORDER BY volume_id",
        "volume_id",
        "region",
    ),
    "vpc": (
        "SELECT vpc_id, region, account_id, cidr_block, state, is_default, instance_tenancy "
        "FROM aws_vpc ORDER BY vpc_id",
        "vpc_id",
        "region",
    ),
    "subnet": (
        "SELECT subnet_id, region, account_id, vpc_id, cidr_block, availability_zone, "
        "available_ip_address_count, map_public_ip_on_launch "
        "FROM aws_vpc_subnet ORDER BY subnet_id",
        "subnet_id",
        "region",
    ),
    "security_group": (
        "SELECT group_id, group_name, region, account_id, vpc_id, description "
        "FROM aws_vpc_security_group ORDER BY group_id",
        "group_id",
        "region",
    ),
    "iam_role": (
        "SELECT name, arn, region, account_id, role_id, create_date, path "
        "FROM aws_iam_role ORDER BY create_date DESC",
        "name",
        "region",
    ),
    "iam_user": (
        "SELECT name, arn, region, account_id, user_id, create_date, mfa_enabled, password_last_used "
        "FROM aws_iam_user ORDER BY create_date DESC",
        "name",
        "region",
    ),
    "dynamodb": (
        "SELECT name, region, account_id, table_status, billing_mode, item_count, table_size_bytes, "
        "read_capacity, write_capacity "
        "FROM aws_dynamodb_table ORDER BY name",
        "name",
        "region",
    ),
    "ecs_cluster": (
        "SELECT cluster_name, region, account_id, status, running_tasks_count, pending_tasks_count, "
        "active_services_count, registered_container_instances_count "
        "FROM aws_ecs_cluster ORDER BY cluster_name",
        "cluster_name",
        "region",
    ),
    "ecr": (
        "SELECT repository_name, region, account_id, repository_uri, image_tag_mutability, created_at "
        "FROM aws_ecr_repository ORDER BY created_at DESC",
        "repository_name",
        "region",
    ),
}
_ALLOWED = set(QUERIES)
_sm = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
_lambda = boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def _ssl_ctx():
    c = ssl.create_default_context()
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    return c


def _secret(arn):
    return _sm.get_secret_value(SecretId=arn)["SecretString"]


def _aurora():
    creds = json.loads(_secret(os.environ["AURORA_SECRET_ARN"]))
    return pg8000.native.Connection(user=creds["username"], password=creds["password"],
                                    host=os.environ["AURORA_ENDPOINT"], database=os.environ["AURORA_DATABASE"],
                                    port=5432, ssl_context=_ssl_ctx())


def _steampipe():
    return pg8000.native.Connection(user="steampipe", password=_secret(os.environ["STEAMPIPE_SECRET_ARN"]).strip(),
                                    host=os.environ["STEAMPIPE_HOST"], database="steampipe",
                                    port=9193, ssl_context=_ssl_ctx())


def sync(resource_type):
    if resource_type not in _ALLOWED:
        return {"error": f"unknown type {resource_type}"}
    sql, id_col, region_col = QUERIES[resource_type]
    adb = _aurora()
    try:
        # advisory lock per type (no Steampipe stampede); skip if busy
        got = adb.run("SELECT pg_try_advisory_lock(hashtext(:t))", t=f"inv:{resource_type}")
        if not got[0][0]:
            return {"status": "busy", "type": resource_type}
        try:
            # mark running INSIDE the try so a throw here records 'failed' and the finally still unlocks
            adb.run("INSERT INTO inventory_sync_runs (resource_type, status, started_at, finished_at, row_count, error) "
                    "VALUES (:t,'running',now(),NULL,NULL,NULL) "
                    "ON CONFLICT (resource_type, account_id) DO UPDATE SET status='running', started_at=now(), "
                    "finished_at=NULL, error=NULL", t=resource_type)
            sdb = _steampipe()
            try:
                rows = sdb.run(sql)
                cols = [c["name"] for c in sdb.columns]
            finally:
                sdb.close()  # close even if the Steampipe query throws
            seen = []
            for r in rows:
                rec = dict(zip(cols, r))
                rid = str(rec.get(id_col))
                region = str(rec.get(region_col) or "")
                seen.append((region, rid))
                adb.run("INSERT INTO inventory_resources (resource_type, account_id, region, resource_id, data, captured_at) "
                        "VALUES (:t,'self',:rg,:id,:d::jsonb,now()) "
                        "ON CONFLICT (resource_type, account_id, region, resource_id) "
                        "DO UPDATE SET data=:d::jsonb, captured_at=now()",
                        t=resource_type, rg=region, id=rid, d=json.dumps(rec, default=str))
            # delete stale rows of this type not in the latest run
            existing = adb.run("SELECT region, resource_id FROM inventory_resources WHERE resource_type=:t AND account_id='self'", t=resource_type)
            for rg, rid in existing:
                if (rg, rid) not in seen:
                    adb.run("DELETE FROM inventory_resources WHERE resource_type=:t AND account_id='self' AND region=:rg AND resource_id=:id", t=resource_type, rg=rg, id=rid)
            adb.run("UPDATE inventory_sync_runs SET status='succeeded', finished_at=now(), row_count=:n, error=NULL "
                    "WHERE resource_type=:t AND account_id='self'", t=resource_type, n=len(rows))
            return {"status": "succeeded", "type": resource_type, "row_count": len(rows)}
        except Exception as e:
            adb.run("UPDATE inventory_sync_runs SET status='failed', finished_at=now(), error=:e "
                    "WHERE resource_type=:t AND account_id='self'", t=resource_type, e=str(e)[:2000])
            return {"status": "failed", "type": resource_type, "error": str(e)[:300]}
        finally:
            adb.run("SELECT pg_advisory_unlock(hashtext(:t))", t=f"inv:{resource_type}")
    finally:
        adb.close()


def lambda_handler(event, ctx):
    rtype = (event or {}).get("type", "all")
    if rtype == "all":
        for rt in QUERIES:
            _lambda.invoke(FunctionName=ctx.invoked_function_arn, InvocationType="Event",
                           Payload=json.dumps({"type": rt}).encode())
        return {"status": "dispatched", "types": list(QUERIES)}
    return sync(rtype)
