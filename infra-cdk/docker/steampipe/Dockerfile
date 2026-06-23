# Steampipe sidecar for the AWSops dev ECS Fargate task (ADR-030).
#
# Listens on 0.0.0.0:9193 with `--database-listen network` so the Next.js
# container in the same task can reach it via 127.0.0.1:9193 (shared task
# network namespace). AWS plugin is baked in at build time so the running
# container does not have to pull during task startup.
#
# Credentials: Steampipe's aws plugin reads from the AWS SDK default credential
# chain, which on ECS Fargate resolves to the task role attached by
# AwsopsDevEcsStack (TaskRole with ReadOnlyAccess). No static credentials.
#
# Build:
#   docker buildx build --platform linux/arm64 \
#     -t <ecr-uri>/awsops-dev:steampipe-latest \
#     -f infra-cdk/docker/steampipe/Dockerfile \
#     --push infra-cdk/docker/steampipe

FROM --platform=linux/arm64 turbot/steampipe:latest

# Run as the bundled steampipe user (already created by the base image).
USER steampipe

# Pre-install the AWS plugin so the running container doesn't have to fetch
# it at task start. Plugin lives under /home/steampipe/.steampipe/plugins/.
RUN steampipe plugin install aws

# Bake a minimal aws.spc that picks up credentials from the task role.
# `regions = ["*"]` mirrors the EC2 deployment's connection scope.
RUN mkdir -p /home/steampipe/.steampipe/config \
 && printf 'connection "aws" {\n  plugin  = "aws"\n  regions = ["*"]\n}\n' \
    > /home/steampipe/.steampipe/config/aws.spc

EXPOSE 9193

# `--database-listen network` is required for the Next.js sidecar to reach
# Steampipe via 127.0.0.1 (Fargate awsvpc networking shares loopback across
# containers in the same task). `--foreground` keeps PID 1 alive for ECS.
CMD ["steampipe", "service", "start", \
     "--database-listen=network", \
     "--database-port=9193", \
     "--foreground"]
