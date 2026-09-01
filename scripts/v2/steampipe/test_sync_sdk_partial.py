"""SDK inventory collectors preserve successful rows while surfacing safe partial-failure metadata."""
from botocore.exceptions import ClientError

import sync_lambda


def _client_error(code, operation, message="credential=supersecret resource=secret-id"):
    return ClientError({"Error": {"Code": code, "Message": message}}, operation)


def test_cloudfront_collector_returns_rows_and_redacted_failure_metadata(monkeypatch, capsys):
    class FakeCloudFront:
        def list_vpc_origins(self, **kwargs):
            return {"VpcOriginList": {"Items": [{"Id": "vo-good"}, {"Id": "vo-secret"}]}}

        def get_vpc_origin(self, Id):
            if Id == "vo-secret":
                raise _client_error("AccessDenied", "GetVpcOrigin")
            return {"VpcOrigin": {
                "Status": "Deployed",
                "VpcOriginEndpointConfig": {"Name": "good", "Arn": "arn:good"},
            }}

        def list_distributions(self, **kwargs):
            return {"DistributionList": {
                "Items": [{"Id": "dist-good"}, {"Id": "dist-secret"}],
            }}

        def get_distribution_config(self, Id):
            if Id == "dist-secret":
                raise _client_error("ThrottlingException", "GetDistributionConfig")
            return {"DistributionConfig": {"Origins": {"Items": [{
                "DomainName": "internal.example",
                "VpcOriginConfig": {"VpcOriginId": "vo-good"},
            }]}}}

    monkeypatch.setattr(sync_lambda.boto3, "client", lambda *args, **kwargs: FakeCloudFront())

    rows, id_col, region_col, failures = sync_lambda._fetch_cloudfront_vpc_origins()

    assert id_col == "resource_id"
    assert region_col == "region"
    assert [row["resource_id"] for row in rows] == ["vo-good"]
    assert failures == {
        "failure_count": 2,
        "failure_types": ["ClientError:AccessDenied", "ClientError:ThrottlingException"],
    }
    output = capsys.readouterr().out
    assert "supersecret" not in output
    assert "vo-secret" not in output
    assert "dist-secret" not in output


def test_alb_listener_collector_returns_good_rows_and_safe_partial_metadata(monkeypatch, capsys):
    class FakeElbv2:
        def describe_load_balancers(self, **kwargs):
            return {"LoadBalancers": [
                {"Type": "application", "LoadBalancerArn": "arn:good"},
                {"Type": "application", "LoadBalancerArn": "arn:secret"},
            ]}

        def describe_listeners(self, LoadBalancerArn):
            if LoadBalancerArn == "arn:secret":
                raise _client_error("AccessDeniedException", "DescribeListeners")
            return {"Listeners": [{
                "ListenerArn": "listener:good",
                "Port": 443,
                "Protocol": "HTTPS",
            }]}

        def describe_rules(self, ListenerArn):
            return {"Rules": [{
                "RuleArn": "rule:good",
                "Priority": "default",
                "IsDefault": True,
                "Conditions": [],
                "Actions": [],
            }]}

    monkeypatch.setattr(sync_lambda.boto3, "client", lambda *args, **kwargs: FakeElbv2())

    rows, id_col, region_col, failures = sync_lambda._fetch_alb_listener_rules()

    assert id_col == "resource_id"
    assert region_col == "region"
    assert [row["resource_id"] for row in rows] == ["rule:good"]
    assert failures == {
        "failure_count": 1,
        "failure_types": ["ClientError:AccessDeniedException"],
    }
    output = capsys.readouterr().out
    assert "supersecret" not in output
    assert "arn:secret" not in output


def test_s3_security_collector_keeps_row_and_reports_only_failure_codes(capsys):
    class FakeS3:
        def list_buckets(self):
            return {"Buckets": [{"Name": "secret-bucket"}]}

        def get_bucket_location(self, Bucket):
            return {"LocationConstraint": "ap-northeast-2"}

        def get_bucket_versioning(self, Bucket):
            raise _client_error("AccessDenied", "GetBucketVersioning")

        def get_bucket_encryption(self, Bucket):
            raise _client_error(
                "ServerSideEncryptionConfigurationNotFoundError",
                "GetBucketEncryption",
            )

        def get_bucket_logging(self, Bucket):
            raise _client_error("SlowDown", "GetBucketLogging")

    rows, id_col, region_col, failures = sync_lambda._fetch_s3_security(FakeS3())

    assert id_col == "name"
    assert region_col == "region"
    assert rows[0]["name"] == "secret-bucket"
    assert rows[0]["versioning_enabled"] is None
    assert rows[0]["encryption"] == "none"
    assert rows[0]["logging_enabled"] is None
    assert failures == {
        "failure_count": 2,
        "failure_types": ["ClientError:AccessDenied", "ClientError:SlowDown"],
    }
    output = capsys.readouterr().out
    assert "supersecret" not in output
    assert "secret-bucket" not in output


def test_opensearch_serverless_response_errors_become_safe_partial_metadata(capsys):
    class FakeAoss:
        def list_collections(self, **kwargs):
            return {
                "collectionSummaries": [
                    {"id": "collection-good"},
                    {"id": "collection-secret"},
                ]
            }

        def batch_get_collection(self, ids):
            return {
                "collectionDetails": [{
                    "id": "collection-good",
                    "name": "good",
                    "arn": "arn:aws:aoss:ap-northeast-2:111111111111:collection/good",
                    "status": "ACTIVE",
                }],
                "collectionErrorDetails": [{
                    "id": "collection-secret",
                    "name": "secret-name",
                    "errorCode": "AccessDeniedException",
                    "errorMessage": "credential=supersecret account=222222222222",
                }],
            }

    rows, id_col, region_col, failures = sync_lambda._fetch_opensearch_serverless(FakeAoss())

    assert id_col == "name"
    assert region_col == "region"
    assert [row["name"] for row in rows] == ["good"]
    assert failures == {
        "failure_count": 1,
        "failure_types": ["CollectionError:AccessDeniedException"],
    }
    output = capsys.readouterr().out
    assert "supersecret" not in output
    assert "collection-secret" not in output
    assert "secret-name" not in output
    assert "222222222222" not in output
