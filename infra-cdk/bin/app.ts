#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsopsStack } from '../lib/awsops-stack';
import { CognitoStack } from '../lib/cognito-stack';
import { AgentCoreStack } from '../lib/agentcore-stack';
import { AwsopsDataStack } from '../lib/awsops-data-stack';
import { AwsopsDevEcsStack } from '../lib/awsops-dev-ecs-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-2',
};

// Main infrastructure stack: VPC, ALB, EC2, CloudFront, SSM endpoints
const infra = new AwsopsStack(app, 'AwsopsStack', {
  env,
  description: 'AWSops Dashboard - VPC, ALB, EC2, CloudFront infrastructure',
});

// Custom domain (optional): cdk deploy -c customDomain=awsops.example.com
const customDomain = app.node.tryGetContext('customDomain') as string | undefined;
// Dev environment domain (ADR-030 ECS Fargate; default off):
//   cdk deploy AwsopsDevEcsStack -c enableDevEcs=true -c devDomain=awsops-dev.atomai.click
const devDomain = app.node.tryGetContext('devDomain') as string | undefined;

// Cognito authentication stack: User Pool, Lambda@Edge, CloudFront integration.
// Dev callback URL is registered additively when devDomain is set, so the
// same User Pool serves both prod EC2 and dev ECS without disrupting prod logins.
const cognito = new CognitoStack(app, 'AwsopsCognitoStack', {
  env: { account: env.account, region: 'us-east-1' }, // Lambda@Edge must be in us-east-1
  crossRegionReferences: true,
  description: 'AWSops Dashboard - Cognito authentication with Lambda@Edge',
  distribution: infra.distribution,
  customDomain,
  extraCallbackDomains: devDomain ? [devDomain] : undefined,
});
cognito.addDependency(infra);

// AgentCore AI stack (placeholder)
const agentCore = new AgentCoreStack(app, 'AwsopsAgentCoreStack', {
  env,
  description: 'AWSops Dashboard - Bedrock AgentCore Runtime and Gateway',
});
agentCore.addDependency(infra);

// ADR-030 Phase 1: Aurora Serverless v2 for application state.
// Deployed conditionally via context flag so existing single-host deployments
// stay unchanged: `cdk deploy AwsopsDataStack -c enableAurora=true`.
let dataStack: AwsopsDataStack | undefined;
if (app.node.tryGetContext('enableAurora') === 'true') {
  dataStack = new AwsopsDataStack(app, 'AwsopsDataStack', {
    env,
    description: 'AWSops Dashboard - Aurora Serverless v2 application state (ADR-030)',
    vpc: infra.vpc,
    appSecurityGroup: infra.appSecurityGroup,
  });
  dataStack.addDependency(infra);
}

// ADR-030 dev ECS Fargate environment. Reuses the AwsopsStack VPC, runs the
// Next.js dashboard + Steampipe sidecar on Fargate behind a dev-only ALB +
// CloudFront. Default off so existing EC2 prod stays untouched:
//   cdk deploy AwsopsDevEcsStack \
//     -c enableDevEcs=true \
//     -c devDomain=awsops-dev.atomai.click \
//     -c cloudFrontPrefixListId=pl-22a6434b
if (app.node.tryGetContext('enableDevEcs') === 'true') {
  if (!devDomain) {
    throw new Error('enableDevEcs requires `devDomain` context (e.g. -c devDomain=awsops-dev.atomai.click)');
  }
  const prefixListId =
    (app.node.tryGetContext('cloudFrontPrefixListId') as string | undefined) || 'pl-22a6434b';

  const devEcs = new AwsopsDevEcsStack(app, 'AwsopsDevEcsStack', {
    env,
    description: 'AWSops Dashboard - dev ECS Fargate environment (ADR-030)',
    vpc: infra.vpc,
    cloudFrontPrefixListId: prefixListId,
    customDomain: devDomain,
    // Cross-stack Aurora wiring. Pass primitive ARNs/hostnames rather than
    // Construct refs to avoid cyclic dependencies (the ECS Secret integration
    // would otherwise call `secret.grantRead(executionRole)` and pin a
    // policy on the data stack's secret referencing the dev stack's role).
    // KMS key ARN is required too — fromSecretCompleteArn alone wouldn't
    // grant kms:Decrypt and task startup would fail with KMS AccessDenied.
    auroraHost: dataStack?.cluster.clusterEndpoint.hostname,
    auroraPort: dataStack ? cdk.Token.asString(dataStack.cluster.clusterEndpoint.port) : undefined,
    auroraSecretArn: dataStack?.credentialsSecret.secretArn,
    auroraSecretKeyArn: dataStack?.storageKey.keyArn,
    auroraDatabaseName: 'awsops',
  });
  devEcs.addDependency(infra);
  if (dataStack) {
    devEcs.addDependency(dataStack);
  }
}

app.synth();
