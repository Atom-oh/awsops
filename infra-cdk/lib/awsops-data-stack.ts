import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface AwsopsDataStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  appSecurityGroup: ec2.ISecurityGroup;
}

/**
 * ADR-030 Phase 1: Aurora Serverless v2 (PostgreSQL 15) for application state.
 *
 * Replaces local data/*.json persistence (inventory snapshots, cost snapshots,
 * agentcore memory, agentcore stats, alert diagnosis, event scaling plans,
 * report schedules). Steampipe is NOT migrated — it remains stateless as its
 * own container with config mounted from Secrets Manager (Phase 3).
 *
 * Cluster sits in the existing VPC's PRIVATE_WITH_EGRESS subnets, reachable
 * only from the AWSops app security group on port 5432.
 */
export class AwsopsDataStack extends cdk.Stack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly credentialsSecret: secretsmanager.ISecret;
  public readonly clusterSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AwsopsDataStackProps) {
    super(scope, id, props);

    const databaseName = 'awsops';
    const masterUsername = 'awsops_admin';

    // KMS CMK for storage + secret encryption (audit trail across both services).
    const storageKey = new kms.Key(this, 'AuroraStorageKey', {
      description: 'AWSops Aurora storage + Secrets Manager encryption (ADR-030)',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    storageKey.addAlias('alias/awsops-aurora');

    // Auto-generated master credentials. The secret is the source of truth —
    // the app fetches it at runtime (or via env injection from CDK output).
    this.credentialsSecret = new secretsmanager.Secret(this, 'AuroraMasterSecret', {
      secretName: 'awsops/aurora/master',
      description: 'AWSops Aurora master credentials (ADR-030 Phase 1)',
      encryptionKey: storageKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: masterUsername }),
        generateStringKey: 'password',
        passwordLength: 32,
        excludeCharacters: '"@/\\\'',
      },
    });

    // Security group: app SG is the only allowed source on 5432.
    this.clusterSecurityGroup = new ec2.SecurityGroup(this, 'AuroraSG', {
      vpc: props.vpc,
      description: 'AWSops Aurora cluster SG — app-only ingress on 5432',
      allowAllOutbound: false,
    });
    this.clusterSecurityGroup.addIngressRule(
      props.appSecurityGroup,
      ec2.Port.tcp(5432),
      'AWSops app/Fargate tasks → Aurora',
    );

    // Subnet group from PRIVATE_WITH_EGRESS subnets in the existing VPC.
    const subnetGroup = new rds.SubnetGroup(this, 'AuroraSubnetGroup', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      description: 'AWSops Aurora private subnet group',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Parameter groups: Aurora distinguishes cluster-level vs instance-level.
    // `rds.logical_replication` is cluster-level — must live on a cluster
    // parameter group, otherwise it's silently ignored.
    // Aurora의 cluster vs instance 파라미터 구분을 명시적으로 분리.
    const engine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_15_5,
    });

    const clusterParameterGroup = new rds.ParameterGroup(this, 'AuroraClusterParameterGroup', {
      engine,
      description: 'AWSops Aurora cluster-level parameters',
      parameters: {
        // Required for future Phase 2 change capture during dual-write.
        'rds.logical_replication': '1',
      },
    });

    const instanceParameterGroup = new rds.ParameterGroup(this, 'AuroraInstanceParameterGroup', {
      engine,
      description: 'AWSops Aurora instance-level parameters',
      parameters: {
        'log_min_duration_statement': '1000',
        'log_statement': 'ddl',
        'log_lock_waits': '1',
      },
    });

    // Aurora Serverless v2: 0.5 ACU floor (~$43/mo idle) to 4 ACU ceiling.
    // ADR-030 cost estimate is anchored on this range.
    this.cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      clusterIdentifier: 'awsops-aurora',
      engine,
      credentials: rds.Credentials.fromSecret(this.credentialsSecret),
      defaultDatabaseName: databaseName,
      vpc: props.vpc,
      subnetGroup,
      securityGroups: [this.clusterSecurityGroup],
      parameterGroup: clusterParameterGroup,
      storageEncrypted: true,
      storageEncryptionKey: storageKey,
      iamAuthentication: true,
      backup: {
        retention: cdk.Duration.days(7),
        preferredWindow: '17:00-18:00', // 02:00-03:00 KST
      },
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: cdk.aws_logs.RetentionDays.ONE_MONTH,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        autoMinorVersionUpgrade: true,
        publiclyAccessible: false,
        parameterGroup: instanceParameterGroup,
      }),
      readers: [
        rds.ClusterInstance.serverlessV2('Reader1', {
          autoMinorVersionUpgrade: true,
          publiclyAccessible: false,
          scaleWithWriter: true,
          parameterGroup: instanceParameterGroup,
        }),
      ],
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,
    });

    // Allow the cluster KMS key to be used by RDS service for snapshot copy.
    storageKey.grantEncryptDecrypt(new cdk.aws_iam.ServicePrincipal('rds.amazonaws.com'));

    // -----------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------
    new cdk.CfnOutput(this, 'ClusterEndpoint', {
      value: this.cluster.clusterEndpoint.hostname,
      description: 'Aurora writer endpoint',
      exportName: 'AwsopsAuroraEndpoint',
    });
    new cdk.CfnOutput(this, 'ClusterReaderEndpoint', {
      value: this.cluster.clusterReadEndpoint.hostname,
      description: 'Aurora reader endpoint',
      exportName: 'AwsopsAuroraReaderEndpoint',
    });
    new cdk.CfnOutput(this, 'ClusterPort', {
      value: cdk.Token.asString(this.cluster.clusterEndpoint.port),
      description: 'Aurora port (5432)',
      exportName: 'AwsopsAuroraPort',
    });
    new cdk.CfnOutput(this, 'DatabaseName', {
      value: databaseName,
      description: 'Default database name',
      exportName: 'AwsopsAuroraDatabase',
    });
    new cdk.CfnOutput(this, 'MasterSecretArn', {
      value: this.credentialsSecret.secretArn,
      description: 'Secrets Manager ARN for master credentials',
      exportName: 'AwsopsAuroraSecretArn',
    });
    new cdk.CfnOutput(this, 'SecurityGroupId', {
      value: this.clusterSecurityGroup.securityGroupId,
      description: 'Aurora cluster security group ID',
      exportName: 'AwsopsAuroraSecurityGroup',
    });
  }
}
