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
        # v1-parity (src/lib/queries/ec2.ts `detail` + `list`): full instance detail + instance-type
        # specs JOIN, stored in `data` so the detail panel matches v1. No feature reduced vs v1.
        "SELECT i.instance_id, (i.tags ->> 'Name') AS name, i.instance_type, i.instance_state, "
        "i.region, i.account_id, i.image_id, i.key_name, i.architecture, i.platform_details, "
        "i.virtualization_type, i.hypervisor, i.ebs_optimized, i.ena_support, i.monitoring_state, "
        "i.placement_availability_zone, i.placement_tenancy, i.private_ip_address, i.private_dns_name, "
        "i.public_ip_address, i.public_dns_name, i.vpc_id, i.subnet_id, i.cpu_options_core_count, "
        "i.cpu_options_threads_per_core, i.root_device_type, i.root_device_name, "
        "i.iam_instance_profile_arn, i.launch_time, i.state_transition_time, "
        "i.security_groups, i.block_device_mappings, i.network_interfaces, i.tags, "
        "(t.memory_info ->> 'SizeInMiB') AS memory_mib, (t.v_cpu_info ->> 'DefaultVCpus') AS vcpus, "
        "(t.network_info ->> 'NetworkPerformance') AS network_performance, "
        "(t.network_info ->> 'MaximumNetworkInterfaces') AS max_enis, t.instance_storage_supported "
        "FROM aws_ec2_instance i LEFT JOIN aws_ec2_instance_type t ON i.instance_type = t.instance_type "
        "ORDER BY i.launch_time DESC",
        "instance_id",
        "region",
    ),
    "s3": (
        # ListBuckets-sourced columns only. versioning_enabled/bucket_policy_is_public trigger
        # per-bucket GetBucketVersioning/GetBucketPolicyStatus, which a restrictive bucket
        # resource policy (e.g. eks-hybrid-packages) can explicit-deny — and one denied bucket
        # fails the WHOLE aws_s3_bucket query. Keep S3 robust against arbitrary bucket policies.
        "SELECT name, region, account_id, arn, creation_date "
        "FROM aws_s3_bucket ORDER BY creation_date DESC",
        "name",
        "region",
    ),
    "lambda": (
        "SELECT name, region, account_id, arn, runtime, handler, code_size, memory_size, timeout, "
        "last_modified, version, state, last_update_status, package_type, architectures, layers, "
        "vpc_id, vpc_subnet_ids, vpc_security_group_ids, description, code_sha_256 "
        "FROM aws_lambda_function ORDER BY name",
        "name",
        "region",
    ),
    "rds": (
        # NON-metric detail fields only; v1's rdsMetrics CloudWatch JOIN is live/heavy → F5, not stored here.
        "SELECT db_instance_identifier, region, account_id, arn, engine, engine_version, class, status, "
        "multi_az, publicly_accessible, allocated_storage, storage_type, storage_encrypted, kms_key_id, "
        "vpc_id, db_subnet_group_name, availability_zone, endpoint_address, endpoint_port, "
        "backup_retention_period, preferred_backup_window, latest_restorable_time, vpc_security_groups, "
        "auto_minor_version_upgrade, copy_tags_to_snapshot, deletion_protection, "
        "iam_database_authentication_enabled, performance_insights_enabled, create_time, tags "
        "FROM aws_rds_db_instance ORDER BY db_instance_identifier",
        "db_instance_identifier",
        "region",
    ),
    "ebs_volume": (
        "SELECT volume_id, region, account_id, arn, volume_type, size, state, encrypted, iops, "
        "availability_zone, create_time, snapshot_id, kms_key_id, multi_attach_enabled, attachments, tags, "
        "(tags ->> 'Name') AS name "
        "FROM aws_ebs_volume ORDER BY volume_id",
        "volume_id",
        "region",
    ),
    "vpc": (
        "SELECT vpc_id, region, account_id, arn, cidr_block, state, is_default, instance_tenancy, "
        "dhcp_options_id, owner_id, tags, (tags ->> 'Name') AS name "
        "FROM aws_vpc ORDER BY vpc_id",
        "vpc_id",
        "region",
    ),
    "subnet": (
        "SELECT subnet_id, region, account_id, subnet_arn, vpc_id, cidr_block, state, owner_id, "
        "availability_zone, availability_zone_id, available_ip_address_count, map_public_ip_on_launch, "
        "default_for_az, assign_ipv6_address_on_creation, tags, (tags ->> 'Name') AS name "
        "FROM aws_vpc_subnet ORDER BY subnet_id",
        "subnet_id",
        "region",
    ),
    "security_group": (
        "SELECT group_id, region, account_id, arn, group_name, vpc_id, description, owner_id, "
        "ip_permissions, ip_permissions_egress, tags, (tags ->> 'Name') AS name "
        "FROM aws_vpc_security_group ORDER BY group_id",
        "group_id",
        "region",
    ),
    "iam_role": (
        "SELECT name, region, account_id, arn, role_id, create_date, path, description, "
        "max_session_duration, role_last_used_date, role_last_used_region, instance_profile_arns, "
        "permissions_boundary_arn, assume_role_policy, tags "
        "FROM aws_iam_role ORDER BY create_date DESC",
        "name",
        "region",
    ),
    "iam_user": (
        "SELECT name, region, account_id, arn, user_id, create_date, path, password_last_used, "
        "mfa_enabled, tags "
        "FROM aws_iam_user ORDER BY create_date DESC",
        "name",
        "region",
    ),
    "dynamodb": (
        "SELECT name, region, account_id, arn, table_status, billing_mode, item_count, table_size_bytes, "
        "read_capacity, write_capacity, key_schema, point_in_time_recovery_description, sse_description, "
        "creation_date_time, tags "
        "FROM aws_dynamodb_table ORDER BY name",
        "name",
        "region",
    ),
    "ecs_cluster": (
        "SELECT cluster_name, region, account_id, cluster_arn, status, running_tasks_count, "
        "pending_tasks_count, active_services_count, registered_container_instances_count, settings, tags "
        "FROM aws_ecs_cluster ORDER BY cluster_name",
        "cluster_name",
        "region",
    ),
    "ecr": (
        "SELECT repository_name, region, account_id, arn, registry_id, repository_uri, "
        "image_tag_mutability, image_scanning_configuration, encryption_configuration, lifecycle_policy, "
        "created_at, tags "
        "FROM aws_ecr_repository ORDER BY created_at DESC",
        "repository_name",
        "region",
    ),
    # ---- D3 wave (verified columns; all Describe/List-based) ----
    "cloudfront": (
        "SELECT id, region, account_id, arn, domain_name, status, enabled, e_tag, http_version, "
        "is_ipv6_enabled, price_class, web_acl_id, default_cache_behavior, origins, aliases, "
        "cache_behaviors, tags, (tags ->> 'Name') AS name "
        "FROM aws_cloudfront_distribution ORDER BY id",
        "id",
        "region",
    ),
    "alb": (
        "SELECT name, region, account_id, arn, type, scheme, state_code, vpc_id, dns_name, "
        "ip_address_type, canonical_hosted_zone_id, availability_zones, security_groups, created_time, tags "
        "FROM aws_ec2_application_load_balancer ORDER BY name",
        "name",
        "region",
    ),
    "nlb": (
        "SELECT name, region, account_id, arn, type, scheme, state_code, vpc_id, dns_name, "
        "ip_address_type, canonical_hosted_zone_id, availability_zones, security_groups, created_time, tags "
        "FROM aws_ec2_network_load_balancer ORDER BY name",
        "name",
        "region",
    ),
    "target_group": (
        # Request-flow topology: load_balancer_arns links TG->ALB/NLB; target_health_descriptions
        # (jsonb, hydrated via DescribeTargetHealth) carries each target's id/IP + health state.
        # Nested jsonb keys are PascalCase (AWS SDK shape): target_health_descriptions[].Target.Id,
        # .TargetHealth.State — kept as jsonb (not ::text) so the BFF reads them as nested objects.
        "SELECT target_group_arn, region, account_id, target_group_name, target_type, vpc_id, "
        "protocol, port, load_balancer_arns, health_check_enabled, health_check_protocol, "
        "health_check_path, target_health_descriptions "
        "FROM aws_ec2_target_group ORDER BY target_group_name",
        "target_group_arn",
        "region",
    ),
    "elasticache": (
        # NON-metric detail fields only; v1's ecMetrics CloudWatch JOIN is live/heavy → F5, not stored here.
        "SELECT cache_cluster_id, region, account_id, arn, engine, engine_version, cache_node_type, "
        "cache_cluster_status, num_cache_nodes, replication_group_id, preferred_availability_zone, "
        "cache_subnet_group_name, at_rest_encryption_enabled, transit_encryption_enabled, "
        "auth_token_enabled, auto_minor_version_upgrade, snapshot_retention_limit, snapshot_window, "
        "preferred_maintenance_window, cache_cluster_create_time, security_groups, tags "
        "FROM aws_elasticache_cluster ORDER BY cache_cluster_id",
        "cache_cluster_id",
        "region",
    ),
    "opensearch": (
        "SELECT domain_name, region, account_id, arn, domain_id, engine_type, engine_version, processing, "
        "created, deleted, endpoint, node_to_node_encryption_options_enabled, encryption_at_rest_options, "
        "cluster_config, vpc_options, ebs_options, endpoints, cognito_options, advanced_security_options, tags "
        "FROM aws_opensearch_domain ORDER BY domain_name",
        "domain_name",
        "region",
    ),
    "msk": (
        "SELECT cluster_name, region, account_id, arn, state, cluster_type, current_version, creation_time, "
        "provisioned, tags "
        "FROM aws_msk_cluster ORDER BY cluster_name",
        "cluster_name",
        "region",
    ),
    "waf": (
        "SELECT name, region, account_id, id, arn, scope, capacity, description, default_action, rules, "
        "visibility_config, managed_by_firewall_manager, tags "
        "FROM aws_wafv2_web_acl ORDER BY name",
        "name",
        "region",
    ),
    "cloudwatch_alarm": (
        "SELECT name, region, account_id, arn, state_value, state_reason, state_updated_timestamp, "
        "namespace, metric_name, comparison_operator, threshold, period, evaluation_periods, statistic, "
        "actions_enabled, alarm_actions, ok_actions, insufficient_data_actions "
        "FROM aws_cloudwatch_alarm ORDER BY name",
        "name",
        "region",
    ),
    "cloudtrail": (
        "SELECT name, region, account_id, arn, home_region, is_multi_region_trail, is_logging, "
        "log_file_validation_enabled, s3_bucket_name, s3_key_prefix, sns_topic_arn, kms_key_id, "
        "log_group_arn, is_organization_trail, include_global_service_events, has_custom_event_selectors, "
        "has_insight_selectors, latest_delivery_time, latest_delivery_error, start_logging_time, tags "
        "FROM aws_cloudtrail_trail ORDER BY name",
        "name",
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
