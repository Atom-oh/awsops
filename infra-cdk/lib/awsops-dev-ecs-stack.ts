import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface AwsopsDevEcsStackProps extends cdk.StackProps {
  /**
   * VPC to deploy the dev ECS workload into. The dev environment intentionally
   * reuses the prod VPC so we don't pay for a second NAT gateway or duplicate
   * VPC endpoints. Subnets used: PRIVATE_WITH_EGRESS for tasks, PUBLIC for ALB.
   */
  vpc: ec2.IVpc;

  /**
   * CloudFront managed prefix list ID for the origin-facing range
   * (ap-northeast-2 = pl-22a6434b). Same value as AwsopsStack ALB SG; passed
   * through so the dev ALB only accepts CloudFront traffic.
   */
  cloudFrontPrefixListId: string;

  /**
   * Custom domain to attach to the dev CloudFront distribution. ACM cert is
   * provisioned in us-east-1, Route53 A record alias to CloudFront added.
   * Hosted zone is inferred as the parent of the domain
   * (`awsops-dev.atomai.click` → `atomai.click`).
   */
  customDomain: string;

  /**
   * Optional explicit hosted zone name (overrides inference).
   */
  hostedZoneName?: string;

  /**
   * Optional Aurora connection info to wire into the Fargate task. Pass
   * the *primitives* (host string + secret ARN string) rather than CDK
   * Construct references — passing the construct itself triggers an ECS
   * `secret.grantRead(executionRole)` that creates a cyclic dependency
   * between AwsopsDataStack (where the secret lives) and AwsopsDevEcsStack
   * (where the execution role lives).
   *
   * When provided:
   *   - AURORA_HOST/PORT/DB/SSLMODE set as plain env vars
   *   - AURORA_USER/PASSWORD pulled at task start via ECS Secrets Manager
   *     integration against the imported secret ARN
   * `bin/app.ts` extracts these strings from AwsopsDataStack outputs.
   */
  auroraHost?: string;
  auroraPort?: string;
  auroraDatabaseName?: string;
  auroraSecretArn?: string;
}

/**
 * ADR-030 dev ECS Fargate environment. Deploys the AWSops Next.js dashboard
 * as a Fargate service behind a dev-only ALB + CloudFront. Intentionally
 * isolated from the prod EC2 stack — they share only the VPC.
 *
 * Steampipe runs as a sidecar container in the same task definition so the
 * Next.js app can reach it on `127.0.0.1:9193` just like the EC2 deployment.
 *
 * The deployment is gated behind `-c enableDevEcs=true` so the existing
 * single-host workflow stays untouched until the operator opts in.
 */
export class AwsopsDevEcsStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly repository: ecr.Repository;
  public readonly service: ecs.FargateService;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: AwsopsDevEcsStackProps) {
    super(scope, id, props);

    const {
      vpc,
      cloudFrontPrefixListId,
      customDomain,
      hostedZoneName,
      auroraHost,
      auroraPort,
      auroraDatabaseName,
      auroraSecretArn,
    } = props;

    // Reconstruct the secret reference locally so the grant lives entirely
    // inside this stack — no cross-stack policy mutation.
    const auroraSecret = auroraSecretArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'ImportedAuroraSecret', auroraSecretArn)
      : undefined;

    // -------------------------------------------------------
    // ECR repository (dev-tagged so it can't collide with prod)
    // -------------------------------------------------------
    this.repository = new ecr.Repository(this, 'AwsopsDevRepo', {
      repositoryName: 'awsops-dev',
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      lifecycleRules: [{
        description: 'Keep only the 10 most recent images',
        maxImageCount: 10,
      }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // -------------------------------------------------------
    // ECS cluster (Fargate, no EC2 capacity providers)
    // -------------------------------------------------------
    this.cluster = new ecs.Cluster(this, 'AwsopsDevCluster', {
      clusterName: 'awsops-dev',
      vpc,
      containerInsights: true,
    });

    // -------------------------------------------------------
    // Task IAM — execution role pulls from ECR + writes logs;
    //            task role grants runtime AWS permissions to the app.
    // -------------------------------------------------------
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: 'awsops-dev-task-execution',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // PR #26 review fix (CRITICAL): the original draft attached
    // `SecretsManagerReadWrite` which includes `secretsmanager:CreateSecret`,
    // `PutSecretValue`, and `DeleteSecret` — far beyond what a read-only
    // operations dashboard should hold. Replaced with the read-only managed
    // policy.
    //
    // PR #26 review note (MAJOR, deferred): `ReadOnlyAccess` is still broad
    // (account-wide S3 object reads, IAM metadata, etc.). A follow-up will
    // scope this to just the AWS services Steampipe actually queries so dev
    // can't read prod data. Tracked alongside the prod EC2 IAM tightening.
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: 'awsops-dev-task',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess'),
        // Read-only — listing + retrieving Secrets is sufficient for the
        // dashboard. WRITE on Secrets is intentionally excluded.
        iam.ManagedPolicy.fromAwsManagedPolicyName('SecretsManagerReadOnly'),
      ],
    });
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvoke',
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock-runtime:InvokeModel',
        'bedrock-runtime:InvokeModelWithResponseStream',
      ],
      resources: ['*'],
    }));

    // -------------------------------------------------------
    // Task definition — Next.js app + Steampipe sidecar
    // -------------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'TaskLogs', {
      logGroupName: '/ecs/awsops-dev',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: 'awsops-dev',
      cpu: 2048,                                  // 2 vCPU
      memoryLimitMiB: 4096,                       // 4 GB
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      executionRole,
      taskRole,
    });

    // PR #28 follow-up: bake the Steampipe sidecar back in now that the deploy
    // script (14-deploy-dev-ecs.sh) builds + pushes the awsops-steampipe ARM64
    // image. Defined BEFORE the next container so we can wire dependsOn below.
    const steampipeContainer = taskDefinition.addContainer('steampipe', {
      containerName: 'steampipe',
      image: ecs.ContainerImage.fromEcrRepository(this.repository, 'steampipe-latest'),
      essential: true,
      portMappings: [{ containerPort: 9193, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'steampipe',
        logGroup,
      }),
      // Steampipe takes ~10s to bind its FDW Postgres on cold start. The
      // healthcheck pings the network listener so Fargate marks the container
      // healthy only once it accepts TCP connections.
      healthCheck: {
        command: ['CMD-SHELL', 'nc -z 127.0.0.1 9193 || exit 1'],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 5,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    const nextContainer = taskDefinition.addContainer('next', {
      containerName: 'next',
      image: ecs.ContainerImage.fromEcrRepository(this.repository, 'latest'),
      essential: true,
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
        STEAMPIPE_HOST: '127.0.0.1',
        STEAMPIPE_PORT: '9193',
        // Aurora env vars are populated when bin/app.ts passes through the
        // AwsopsDataStack outputs. Setting them unconditionally to non-empty
        // defaults would defeat `isAuroraEnabled()`'s gating in src/lib/db.ts.
        ...(auroraHost
          ? {
              AURORA_HOST: auroraHost,
              AURORA_PORT: auroraPort ?? '5432',
              AURORA_DB: auroraDatabaseName ?? 'awsops',
              AURORA_SSLMODE: 'verify-full',
            }
          : { AURORA_HOST: '' }),
      },
      // ECS Secrets Manager integration — the agent at task-start time fetches
      // these values, exports them as env vars to the container, and the values
      // never appear in plaintext task definitions or describe-tasks output.
      secrets: auroraSecret
        ? {
            AURORA_USER: ecs.Secret.fromSecretsManager(auroraSecret, 'username'),
            AURORA_PASSWORD: ecs.Secret.fromSecretsManager(auroraSecret, 'password'),
          }
        : undefined,
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'next',
        logGroup,
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'wget -q -O - http://127.0.0.1:3000/awsops/api/agentcore || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    // Wait for Steampipe to report HEALTHY before starting the Next.js
    // container — avoids the dashboard's startup queries hitting a
    // connection-refused window during cold starts.
    nextContainer.addContainerDependencies({
      container: steampipeContainer,
      condition: ecs.ContainerDependencyCondition.HEALTHY,
    });

    // -------------------------------------------------------
    // ALB (separate from prod EC2 ALB)
    // -------------------------------------------------------
    const albSg = new ec2.SecurityGroup(this, 'DevALBSg', {
      vpc,
      securityGroupName: 'awsops-dev-alb-sg',
      description: 'AWSops dev ALB — CloudFront prefix list only',
      allowAllOutbound: true,
    });
    new ec2.CfnSecurityGroupIngress(this, 'DevALBIngressFromCloudFront', {
      groupId: albSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      sourcePrefixListId: cloudFrontPrefixListId,
      description: 'HTTPS from CloudFront origin range',
    });
    new ec2.CfnSecurityGroupIngress(this, 'DevALBIngressFromCloudFrontHttp', {
      groupId: albSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 80,
      toPort: 80,
      sourcePrefixListId: cloudFrontPrefixListId,
      description: 'HTTP from CloudFront origin range',
    });

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'DevALB', {
      loadBalancerName: 'awsops-dev-alb',
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'DevTG', {
      targetGroupName: 'awsops-dev-tg',
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,                // required for Fargate
      healthCheck: {
        path: '/awsops/api/agentcore',
        // PR #26 review fix (MAJOR): tightened from `200-499` to `200-399`.
        // 4xx must NOT count as healthy or the ECS deployment circuit breaker
        // can't catch route regressions. The agentcore status route returns
        // 200 unauthenticated, so this stays passing.
        healthyHttpCodes: '200-399',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    this.alb.addListener('Listener80', {
      port: 80,
      defaultTargetGroups: [targetGroup],
    });

    // -------------------------------------------------------
    // ECS Fargate service (1 task to start)
    // -------------------------------------------------------
    const serviceSg = new ec2.SecurityGroup(this, 'DevServiceSg', {
      vpc,
      securityGroupName: 'awsops-dev-service-sg',
      description: 'AWSops dev Fargate tasks',
      allowAllOutbound: true,
    });
    serviceSg.addIngressRule(albSg, ec2.Port.tcp(3000), 'ALB → Fargate Next.js');

    this.service = new ecs.FargateService(this, 'DevService', {
      serviceName: 'awsops-dev',
      cluster: this.cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,                          // private subnets, NAT egress
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [serviceSg],
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,                     // ECS Exec for debugging
    });
    this.service.attachToApplicationTargetGroup(targetGroup);

    // Aurora SG ingress is intentionally NOT added here. Doing
    // `auroraClusterSecurityGroup.addIngressRule(serviceSg, …)` from the dev
    // stack would create a cyclic CDK dependency (data stack would then
    // import the dev service SG). Instead, after deploying both stacks the
    // operator runs:
    //
    //   AURORA_SG=$(aws cloudformation describe-stacks \
    //     --stack-name AwsopsDataStack \
    //     --query "Stacks[0].Outputs[?OutputKey=='SecurityGroupId'].OutputValue" \
    //     --output text)
    //   DEV_SG=$(aws cloudformation describe-stacks \
    //     --stack-name AwsopsDevEcsStack \
    //     --query "Stacks[0].Outputs[?OutputKey=='DevServiceSgId'].OutputValue" \
    //     --output text)
    //   aws ec2 authorize-security-group-ingress \
    //     --group-id "$AURORA_SG" --protocol tcp --port 5432 \
    //     --source-group "$DEV_SG"
    //
    // The DevServiceSgId output below exposes the ID for that step.

    // -------------------------------------------------------
    // ACM cert + Route53 + CloudFront for awsops-dev.atomai.click
    // -------------------------------------------------------
    const zoneName = hostedZoneName || customDomain.split('.').slice(-2).join('.');
    const hostedZone = route53.HostedZone.fromLookup(this, 'DevZone', {
      domainName: zoneName,
    });

    const certificate = new acm.DnsValidatedCertificate(this, 'DevCert', {
      domainName: customDomain,
      hostedZone,
      region: 'us-east-1',                            // CloudFront requirement
    });

    const noCachePolicy = cloudfront.CachePolicy.CACHING_DISABLED;
    const allViewerOriginPolicy = cloudfront.OriginRequestPolicy.ALL_VIEWER;

    const albOrigin = new origins.LoadBalancerV2Origin(this.alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
    });

    // ⚠ PR #26 review (MAJOR, deferred): Lambda@Edge auth function is NOT
    // attached here. CognitoStack creates `awsops-auth-edge` in us-east-1
    // (CDK scaffold only) and `scripts/08-setup-cloudfront-auth.sh` attaches
    // the *published version* of the function to the prod CloudFront's
    // viewer-request after `setup-cognito.sh` overwrites the code. Until
    // an equivalent step runs for THIS distribution, the dev environment
    // is publicly reachable. Mitigations before going live:
    //   1. Run `08-setup-cloudfront-auth.sh` against the dev distribution
    //      ID (see `EcsDistributionId` output below), OR
    //   2. Temporarily attach an AWS WAF web ACL with an IP allowlist to
    //      this distribution.
    // Tracked as a Phase 1.5 follow-up.
    this.distribution = new cloudfront.Distribution(this, 'DevCloudFront', {
      comment: `AWSops dev (ECS Fargate) — ${customDomain}`,
      domainNames: [customDomain],
      certificate,
      defaultBehavior: {
        origin: albOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: noCachePolicy,
        originRequestPolicy: allViewerOriginPolicy,
      },
      additionalBehaviors: {
        '/awsops*': {
          origin: albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: noCachePolicy,
          originRequestPolicy: allViewerOriginPolicy,
        },
        // PR #26 review fix (MINOR): narrowed `/awsops/_next/*` → `/awsops/_next/static/*`.
        // Next.js standalone only emits long-lived hashed assets under
        // `_next/static`. Cache-optimized policy on the broader path could
        // cache `_next/data/*` JSON which must not be cached.
        '/awsops/_next/static/*': {
          origin: albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
      // PR #26 review fix (MINOR): dev does not need the full edge footprint.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    new route53.ARecord(this, 'DevARecord', {
      zone: hostedZone,
      recordName: customDomain,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(this.distribution)),
    });

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'DevURL', {
      value: `https://${customDomain}`,
      description: 'AWSops dev URL',
    });
    new cdk.CfnOutput(this, 'EcrRepoUri', {
      value: this.repository.repositoryUri,
      description: 'ECR repo URI for awsops-dev image push',
    });
    new cdk.CfnOutput(this, 'EcsCluster', {
      value: this.cluster.clusterName,
      description: 'ECS cluster name',
    });
    new cdk.CfnOutput(this, 'EcsService', {
      value: this.service.serviceName,
      description: 'ECS service name (use with `aws ecs update-service`)',
    });
    new cdk.CfnOutput(this, 'DevAlbDns', {
      value: this.alb.loadBalancerDnsName,
      description: 'Dev ALB DNS (for direct testing)',
    });
    new cdk.CfnOutput(this, 'EcsDistributionId', {
      value: this.distribution.distributionId,
      description: 'Dev CloudFront distribution ID — pass to 08-setup-cloudfront-auth.sh to attach Lambda@Edge',
    });
    new cdk.CfnOutput(this, 'DevServiceSgId', {
      value: serviceSg.securityGroupId,
      description: 'Fargate service SG — add as source on the Aurora SG to allow dev tasks to reach the database',
    });
  }
}
