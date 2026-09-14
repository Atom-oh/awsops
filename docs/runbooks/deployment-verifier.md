# Deployment verifier and migration transport

## Verifier identity

`scripts/v2/ci_origin_verifier.py` bootstraps a dedicated Cognito identity whose
only purpose is authenticated read-only deployment verification. It defaults to
a read-only plan; `--apply` is an explicit operator action.

The supplied AWS account, region, project, user pool and secret must agree. The
pool name must be `<project>-pool`; the existing Secrets Manager metadata must
be named `<project>/ci/deployment-verifier`. The deployment owner must provision
and govern that metadata and its reader scope separately. The helper neither
creates it nor infers its manager from the ARN/name. It grants no IAM role and
uses the operator's configured AWS credentials.

```bash
python3 scripts/v2/ci_origin_verifier.py \
  --account <ACCOUNT_ID> \
  --region ap-northeast-2 \
  --project <PROJECT> \
  --user-pool-id <USER_POOL_ID> \
  --secret-arn <VERIFIER_SECRET_ARN>
# Inspect the plan, then repeat the same command with --apply.
```

The identity is `ci-deployment-verifier@<project>.invalid`. Invitation delivery is
suppressed. No groups or administrator permissions are granted. An operator may
separately assign the existing `deployment-verifiers` application group when the
gated readiness endpoint is needed; that exact group, without an IAM role, is
accepted on later bootstrap runs. Other groups are rejected. The helper
generates a permanent password in memory and stores only the `email`/`password`
JSON in Secrets Manager; neither value is printed, placed in a process argument,
or exported to an environment variable.

An existing confirmed/enabled identity with valid credentials is reused without
rotation. An existing identity with a missing secret is an explicit recovery
case, not permission to take over or reset the user. Failure cleanup can remove
only a user created by the current invocation after a fresh exact-`sub` check.
The helper checks Cognito group membership. Operators must also keep this
identity out of the application's SSM administrator email allowlist; the
authenticated `/api/me` result is the final authority check. Basic login/DB/API
smoke does not require the optional readiness group.

## Migration TLS

`make migrate` now verifies both the database certificate chain and hostname.
It uses the already committed public RDS trust bundle at
`scripts/v2/eks/rds-ca-bundle.pem`; an absent/malformed bundle fails closed.
The migration loads and validates the bundle before reading database credentials.

The default operator path still resolves connection metadata through Terraform
outputs. For a CI executor that must not read raw Terraform state,
`CI_MIGRATION_CONTEXT` can point to a private metadata file produced by its
validated release controller. It contains no username or password, and must
match the configured account, region, project and checked-out commit. The
migration runner then confirms the exact endpoint and master-secret ARN through
`DescribeDBClusters` on `<project>-aurora`; regional DNS suffix matching alone
does not establish ownership.

Required metadata fields are `version` (1), `commit`, `account`, `region`,
`project`, `database` (`awsops`), `endpoint`, `secret_arn`, and
`sql_reader_secret_arn`. Only explicit `null` disables reader synchronization.
Missing, foreign, public or malformed context files fail instead of falling
back to Terraform or silently skipping synchronization. Credentials still come
from Secrets Manager; the context is not a credential carrier.

The CI executor must set `CI_COMMIT_SHA`, `CI_EXPECTED_ACCOUNT_ID`,
`CI_EXPECTED_PROJECT`, `AWS_REGION`, and the absolute `CI_MIGRATION_CONTEXT` path.
Install the context as a regular file owned by the migration user with mode
0600. These values guard configuration mistakes; the AWS cluster read supplies
the resource-ownership confirmation.

If an existing user has no credential secret, restore the known governed secret
or use a separately approved credential recovery operation. Do not reset an
unrelated user to make bootstrap pass. For `cleanup: preserved` after an
incomplete create, inspect the reported identity and secret state before any
cleanup. Rotation/removal follows the existing user-offboarding procedure;
coordinate secret updates with the dedicated identity's password rather than
relying on bootstrap to rotate it.

Local regression checks:

```bash
python3 -m unittest discover -s scripts/v2 -p test_ci_origin_verifier.py -v
node --test scripts/v2/migrate-tls.test.mjs scripts/v2/migration-context.test.mjs
```

The TLS checks exercise real local handshakes: trusted certificates pass,
untrusted certificates and hostname mismatches fail. They do not contact AWS.
