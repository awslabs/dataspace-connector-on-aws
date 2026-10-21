// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { resolve } from "path";

import {
  ISecurityGroup,
  IVpc,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
} from "aws-cdk-lib/aws-ec2";

import {
  AwsLogDriverMode,
  ContainerDefinition,
  ContainerDependencyCondition,
  ContainerImage,
  CpuArchitecture,
  FargatePlatformVersion,
  FargateService,
  FargateTaskDefinition,
  ICluster,
  LogDriver,
  Secret as EcsSecret,
} from "aws-cdk-lib/aws-ecs";

import {
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
  DatabaseSecret,
  IDatabaseCluster,
} from "aws-cdk-lib/aws-rds";

import {
  OAuthScope,
  ResourceServerScope,
  UserPool,
  UserPoolClientIdentityProvider,
} from "aws-cdk-lib/aws-cognito";

import {
  ApplicationProtocol,
  ApplicationTargetGroup,
  CfnListenerRule,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";

import {
  BasyxEntry,
  BasyxService,
  DeploymentProfile,
  StateRemovalPolicy,
  toRemovalPolicy,
} from "../config/config";
import { renderAccessRules, renderTrustList } from "./access-rules";
import {
  AURORA_POSTGRES_VERSION,
  BASYX_IMAGES,
  BUSYBOX_IMAGE,
  POSTGRES_CLIENT_IMAGE,
} from "./versions";
import {
  BASYX_PORT,
  READ_SCOPE,
  READ_SCOPE_NAME,
  RESOURCE_SERVER_ID,
  SERVICE_NAMES,
  basyxClientSecretAlias,
  basyxContextPath,
  basyxPriority,
  basyxWriterSecretName,
  cognitoDomainPrefix,
  cognitoTokenUrl,
  dtrUrl,
  validateCognitoDomainPrefix,
} from "./names";

export interface BasyxAlb {
  readonly dnsName: string;
  readonly securityGroupId: string;
  /** Management listener, reached by writers through the management API. */
  readonly managementListenerArn: string;
  /** BaSyx read listener, reached by the dtrConnector's data plane. */
  readonly readListenerArn: string;
}

export interface BasyxStackProps extends StackProps {
  readonly bpnl: string;
  readonly entry: BasyxEntry;
  readonly dtrConnectorId: string;
  readonly deploymentName: string;
  readonly profile: DeploymentProfile;
  /** Already resolved against the deployment default. */
  readonly stateRemovalPolicy: StateRemovalPolicy;
  readonly vpc: IVpc;
  readonly cluster: ICluster;
  readonly alb: BasyxAlb;
}

/** One BPNL's BaSyx Go services (DTR, optionally the Submodel Repository). */
export class BasyxStack extends Stack {
  constructor(scope: Construct, id: string, props: BasyxStackProps) {
    super(scope, id, props);

    const { alb, bpnl, deploymentName, profile, vpc } = props;
    const production = profile === "production";
    const removalPolicy = toRemovalPolicy(props.stateRemovalPolicy);
    validateCognitoDomainPrefix(deploymentName, bpnl);
    const domainPrefix = cognitoDomainPrefix(deploymentName, bpnl);

    // ─── Network ─────────────────────────────────────────────────────────────
    const basyxSg = new SecurityGroup(this, "BasyxSecurityGroup", {
      allowAllOutbound: false,
      description: `BaSyx services of ${bpnl}`,
      vpc,
    });
    const auroraSg = new SecurityGroup(this, "AuroraSecurityGroup", {
      allowAllOutbound: false,
      description: `BaSyx Aurora cluster of ${bpnl}`,
      vpc,
    });
    const albSg = SecurityGroup.fromSecurityGroupId(
      this,
      "AlbSecurityGroup",
      alb.securityGroupId,
    );
    basyxSg.addIngressRule(albSg, Port.tcp(BASYX_PORT), "Shared ALB");
    basyxSg.addEgressRule(auroraSg, Port.tcp(5432), "Aurora");
    basyxSg.addEgressRule(
      Peer.anyIpv4(),
      Port.HTTPS,
      "ECR, Cognito JWKS, logs",
    );
    auroraSg.addIngressRule(basyxSg, Port.tcp(5432), "BaSyx services");

    // ─── Aurora ──────────────────────────────────────────────────────────────
    // Retained with the cluster, so an operator can still log in to a retained cluster.
    const credentialsSecret = new DatabaseSecret(this, "DatabaseSecret", {
      username: "basyx",
    });
    credentialsSecret.applyRemovalPolicy(removalPolicy);
    const database = new DatabaseCluster(this, "Database", {
      engine: DatabaseClusterEngine.auroraPostgres({
        version: AURORA_POSTGRES_VERSION,
      }),
      // Fixed name, like the connector's DynamoDB table: a retained cluster
      // must be deleted manually before the stack can be created again.
      clusterIdentifier: domainPrefix,
      credentials: Credentials.fromSecret(credentialsSecret),
      defaultDatabaseName: SERVICE_NAMES.dtr,
      writer: ClusterInstance.serverlessV2("Writer"),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: production ? 8 : 4,
      serverlessV2AutoPauseDuration: Duration.seconds(300),
      storageEncrypted: true,
      backup: { retention: Duration.days(production ? 7 : 1) },
      securityGroups: [auroraSg],
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      deletionProtection: removalPolicy === RemovalPolicy.RETAIN,
      removalPolicy,
    });

    // ─── Cognito ─────────────────────────────────────────────────────────────
    const userPool = new UserPool(this, "UserPool", {
      selfSignUpEnabled: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    userPool.addDomain("Domain", { cognitoDomain: { domainPrefix } });
    // BaSyx accepts only tokens with this scope; what a client may do is
    // decided by its client_id in the access rules.
    const readScope = new ResourceServerScope({
      scopeName: READ_SCOPE_NAME,
      scopeDescription: "Access to the BaSyx services",
    });
    const resourceServer = userPool.addResourceServer("ResourceServer", {
      identifier: RESOURCE_SERVER_ID,
      scopes: [readScope],
    });
    const scopes = [OAuthScope.resourceServer(resourceServer, readScope)];
    const client = userPool.addClient("DataPlaneClient", {
      generateSecret: true,
      accessTokenValidity: Duration.hours(1),
      oAuth: {
        flows: { clientCredentials: true },
        scopes,
      },
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
    });
    const clientSecretAlias = basyxClientSecretAlias(
      deploymentName,
      props.dtrConnectorId,
    );
    new Secret(this, "DataPlaneClientSecret", {
      secretName: clientSecretAlias,
      description: `Cognito client secret the ${props.dtrConnectorId} data plane uses to call BaSyx`,
      secretStringValue: client.userPoolClientSecret,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // The provider's own apps register twins and submodels with this client.
    const writer = userPool.addClient("WriterClient", {
      generateSecret: true,
      accessTokenValidity: Duration.hours(1),
      oAuth: {
        flows: { clientCredentials: true },
        scopes,
      },
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
    });
    const writerSecret = new Secret(this, "WriterClientSecret", {
      secretName: basyxWriterSecretName(deploymentName, bpnl),
      description: `Cognito client secret for writing to the BaSyx services of ${bpnl}`,
      secretStringValue: writer.userPoolClientSecret,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ─── Services ────────────────────────────────────────────────────────────
    const issuer = userPool.userPoolProviderUrl;
    for (const service of props.entry.services) {
      new BasyxFargateService(
        this,
        service === "dtr" ? "Dtr" : "SubmodelRepository",
        {
          service,
          bpnl,
          accessRules: renderAccessRules(service, {
            clientId: client.userPoolClientId,
            writerClientId: writer.userPoolClientId,
          }),
          trustList: renderTrustList(issuer),
          alb,
          cluster: props.cluster,
          database,
          databaseSecret: credentialsSecret,
          profile,
          securityGroup: basyxSg,
          vpc,
        },
      );
    }

    // ─── Outputs (read by finalize) ──────────────────────────────────────────
    const out = (key: string, value: string) =>
      new CfnOutput(this, key, { key, value });
    out("DtrUrl", dtrUrl(alb.dnsName, bpnl));
    out("TokenUrl", cognitoTokenUrl(domainPrefix, this.region));
    out("ClientId", client.userPoolClientId);
    out("Scope", READ_SCOPE);
    out("ClientSecretAlias", clientSecretAlias);
    out("WriterClientId", writer.userPoolClientId);
    out("WriterClientSecretArn", writerSecret.secretArn);
  }
}

interface BasyxFargateServiceProps {
  readonly service: BasyxService;
  readonly bpnl: string;
  readonly accessRules: string;
  readonly trustList: string;
  readonly alb: BasyxAlb;
  readonly cluster: ICluster;
  readonly database: IDatabaseCluster;
  readonly databaseSecret: ISecret;
  readonly profile: DeploymentProfile;
  readonly securityGroup: ISecurityGroup;
  readonly vpc: IVpc;
}

// From both lib/basyx (tests) and dist/basyx (synth).
const IMAGE_DIR = resolve(__dirname, "../../lib/basyx/image");

/** A pinned BaSyx image, copied into the CDK assets repository in ECR. */
function basyxImage(
  scope: Construct,
  id: string,
  image: string,
): ContainerImage {
  return ContainerImage.fromDockerImageAsset(
    new DockerImageAsset(scope, id, {
      directory: IMAGE_DIR,
      buildArgs: { IMAGE: image },
      platform: Platform.LINUX_ARM64,
    }),
  );
}

const SECURITY_DIR = "/security";
const SECURITY_VOLUME = "security";

/**
 * One BaSyx service: init containers that write the security files, create
 * the database (Submodel Repository only) and migrate the schema, then the
 * runtime container once they all exited successfully.
 */
class BasyxFargateService extends Construct {
  constructor(scope: Construct, id: string, props: BasyxFargateServiceProps) {
    super(scope, id);

    const { service, profile } = props;
    const name = SERVICE_NAMES[service];
    const contextPath = basyxContextPath(props.bpnl, service);
    const retention =
      profile === "production"
        ? RetentionDays.ONE_MONTH
        : RetentionDays.ONE_WEEK;
    const logGroup = new LogGroup(this, "LogGroup", { retention });
    const logging = (container: string) =>
      LogDriver.awsLogs({
        logGroup,
        mode: AwsLogDriverMode.NON_BLOCKING,
        streamPrefix: container,
      });

    const taskDefinition = new FargateTaskDefinition(this, "TaskDefinition", {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: CpuArchitecture.ARM64 },
      volumes: [{ name: SECURITY_VOLUME }],
    });

    // Aurora PostgreSQL 17+ forces TLS (rds.force_ssl=1); BaSyx defaults to sslmode=disable.
    const postgresEnv = {
      POSTGRES_HOST: props.database.clusterEndpoint.hostname,
      POSTGRES_PORT: "5432",
      POSTGRES_DBNAME: name,
      POSTGRES_SSLMODE: "require",
    };
    const postgresSecrets = {
      POSTGRES_USER: EcsSecret.fromSecretsManager(
        props.databaseSecret,
        "username",
      ),
      POSTGRES_PASSWORD: EcsSecret.fromSecretsManager(
        props.databaseSecret,
        "password",
      ),
    };

    const writeFiles = taskDefinition.addContainer("WriteSecurityFiles", {
      containerName: "write-security-files",
      image: ContainerImage.fromRegistry(BUSYBOX_IMAGE),
      essential: false,
      command: [
        "sh",
        "-c",
        `printf '%s' "$ACCESS_RULES" > ${SECURITY_DIR}/access-rules.json && printf '%s' "$TRUSTLIST" > ${SECURITY_DIR}/trustlist.json`,
      ],
      environment: {
        ACCESS_RULES: props.accessRules,
        TRUSTLIST: props.trustList,
      },
      logging: logging("write-security-files"),
    });
    writeFiles.addMountPoints({
      sourceVolume: SECURITY_VOLUME,
      containerPath: SECURITY_DIR,
      readOnly: false,
    });

    let createDatabase: ContainerDefinition | undefined;
    if (service !== "dtr") {
      // Aurora creates only the default database; the second one is created here.
      const exists = `psql -tAc "SELECT 1 FROM pg_database WHERE datname='${name}'" | grep -q 1`;
      createDatabase = taskDefinition.addContainer("CreateDatabase", {
        containerName: "create-database",
        image: ContainerImage.fromRegistry(POSTGRES_CLIENT_IMAGE),
        essential: false,
        command: [
          "sh",
          "-c",
          // Re-check after a failed CREATE in case a concurrent task created it first.
          `${exists} || psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${name}" || ${exists}`,
        ],
        environment: {
          PGHOST: props.database.clusterEndpoint.hostname,
          PGPORT: "5432",
          PGDATABASE: SERVICE_NAMES.dtr,
          PGSSLMODE: "require",
          PGCONNECT_TIMEOUT: "60",
        },
        secrets: {
          PGUSER: postgresSecrets.POSTGRES_USER,
          PGPASSWORD: postgresSecrets.POSTGRES_PASSWORD,
        },
        logging: logging("create-database"),
      });
    }

    const migrate = taskDefinition.addContainer("Migrate", {
      containerName: "migrate",
      image: basyxImage(
        this,
        "MigrateImage",
        BASYX_IMAGES.configurationService,
      ),
      essential: false,
      environment: postgresEnv,
      secrets: postgresSecrets,
      logging: logging("migrate"),
    });
    if (createDatabase) {
      migrate.addContainerDependencies({
        container: createDatabase,
        condition: ContainerDependencyCondition.SUCCESS,
      });
    }

    const binary =
      service === "dtr"
        ? "/app/digitaltwinregistryservice"
        : "/app/submodelrepositoryservice";
    const runtime = taskDefinition.addContainer("Runtime", {
      containerName: name,
      image: basyxImage(
        this,
        "RuntimeImage",
        service === "dtr" ? BASYX_IMAGES.dtr : BASYX_IMAGES.submodelRepository,
      ),
      essential: true,
      // The image default adds -config /config/config.yaml; everything comes from env here.
      command: [binary],
      environment: {
        ...postgresEnv,
        SERVER_PORT: `${BASYX_PORT}`,
        SERVER_STRICTVERIFICATION: "off",
        ABAC_ENABLED: "true",
        ABAC_MODELPATH: `${SECURITY_DIR}/access-rules.json`,
        ABAC_POLICY_FILE_IMPORT: "always",
        OIDC_TRUSTLISTPATH: `${SECURITY_DIR}/trustlist.json`,
        GENERAL_ENABLECUSTOMMIDDLEWAREHEADERINJECTION: "true",
        SERVER_CONTEXTPATH: contextPath,
        ...(service === "dtr" && {
          GENERAL_SUPPORTSSINGULARSUPPLEMENTALSEMANTICID: "true",
        }),
      },
      secrets: postgresSecrets,
      portMappings: [{ containerPort: BASYX_PORT, name }],
      healthCheck: {
        command: ["CMD", "/bin/healthprobe"],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
        retries: 3,
        // Covers an Aurora resume from auto-pause on the first connection.
        startPeriod: Duration.seconds(60),
      },
      logging: logging(name),
    });
    runtime.addMountPoints({
      sourceVolume: SECURITY_VOLUME,
      containerPath: SECURITY_DIR,
      readOnly: true,
    });
    runtime.addContainerDependencies(
      {
        container: writeFiles,
        condition: ContainerDependencyCondition.SUCCESS,
      },
      { container: migrate, condition: ContainerDependencyCondition.SUCCESS },
    );

    const fargateService = new FargateService(this, "Service", {
      cluster: props.cluster,
      taskDefinition,
      desiredCount: 1,
      securityGroups: [props.securityGroup],
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      capacityProviderStrategies:
        profile === "development"
          ? [{ capacityProvider: "FARGATE_SPOT", weight: 1 }]
          : undefined,
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      platformVersion: FargatePlatformVersion.LATEST,
    });
    // The cluster endpoint only resolves once the writer instance exists.
    fargateService.node.addDependency(props.database);

    // Same target group on both listeners: writes arrive on the management
    // listener through the management API, reads from the data plane on its own.
    const targetGroup = new ApplicationTargetGroup(this, "TargetGroup", {
      port: BASYX_PORT,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      vpc: props.vpc,
      healthCheck: { path: `${contextPath}/health` },
      targets: [fargateService],
    });
    const priority = basyxPriority(props.bpnl, service);
    for (const [ruleId, listenerArn] of [
      ["ManagementListenerRule", props.alb.managementListenerArn],
      ["ReadListenerRule", props.alb.readListenerArn],
    ]) {
      new CfnListenerRule(this, ruleId, {
        actions: [
          { type: "forward", targetGroupArn: targetGroup.targetGroupArn },
        ],
        conditions: [
          {
            field: "path-pattern",
            pathPatternConfig: { values: [`${contextPath}/*`] },
          },
        ],
        listenerArn,
        priority,
      });
    }
  }
}
