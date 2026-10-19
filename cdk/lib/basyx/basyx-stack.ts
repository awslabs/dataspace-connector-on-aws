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
  DnsRecordType,
  PrivateDnsNamespace,
} from "aws-cdk-lib/aws-servicediscovery";
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
  DTR_CONTEXT_PATH,
  READ_SCOPE,
  READ_SCOPE_NAME,
  RESOURCE_SERVER_ID,
  SERVICE_NAMES,
  basyxClientSecretAlias,
  basyxNamespaceName,
  cognitoDomainPrefix,
  cognitoTokenUrl,
  dtrUrl,
} from "./names";

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
  /** Security group of the dtrConnector's data plane, the only allowed caller. */
  readonly dataPlaneSecurityGroup: ISecurityGroup;
}

/** One BPNL's BaSyx Go services (DTR, optionally the Submodel Repository). */
export class BasyxStack extends Stack {
  constructor(scope: Construct, id: string, props: BasyxStackProps) {
    super(scope, id, props);

    const { bpnl, deploymentName, profile, vpc } = props;
    const production = profile === "production";
    const removalPolicy = toRemovalPolicy(props.stateRemovalPolicy);
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
    basyxSg.addIngressRule(
      Peer.securityGroupId(props.dataPlaneSecurityGroup.securityGroupId),
      Port.tcp(BASYX_PORT),
      "dtrConnector data plane",
    );
    basyxSg.addEgressRule(auroraSg, Port.tcp(5432), "Aurora");
    basyxSg.addEgressRule(
      Peer.anyIpv4(),
      Port.HTTPS,
      "ECR, Cognito JWKS, logs",
    );
    auroraSg.addIngressRule(basyxSg, Port.tcp(5432), "BaSyx services");

    const namespace = new PrivateDnsNamespace(this, "Namespace", {
      name: basyxNamespaceName(deploymentName, bpnl),
      vpc,
    });

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
      readers: production
        ? [ClusterInstance.serverlessV2("Reader", { scaleWithWriter: true })]
        : [],
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
    const readScope = new ResourceServerScope({
      scopeName: READ_SCOPE_NAME,
      scopeDescription: "Read access to the BaSyx services",
    });
    const resourceServer = userPool.addResourceServer("ResourceServer", {
      identifier: RESOURCE_SERVER_ID,
      scopes: [readScope],
    });
    const client = userPool.addClient("DataPlaneClient", {
      generateSecret: true,
      accessTokenValidity: Duration.hours(1),
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [OAuthScope.resourceServer(resourceServer, readScope)],
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

    // ─── Services ────────────────────────────────────────────────────────────
    const issuer = userPool.userPoolProviderUrl;
    const services: BasyxService[] = ["dtr"];
    if (props.entry.services.includes("submodelRepository")) {
      services.push("submodelRepository");
    }
    for (const service of services) {
      new BasyxFargateService(
        this,
        service === "dtr" ? "Dtr" : "SubmodelRepository",
        {
          service,
          accessRules: renderAccessRules(service, {
            clientId: client.userPoolClientId,
          }),
          trustList: renderTrustList(issuer),
          cluster: props.cluster,
          database,
          databaseSecret: credentialsSecret,
          namespace,
          profile,
          securityGroup: basyxSg,
        },
      );
    }

    // ─── Outputs (read by finalize) ──────────────────────────────────────────
    const out = (key: string, value: string) =>
      new CfnOutput(this, key, { key, value });
    out("DtrUrl", dtrUrl(namespace.namespaceName));
    out("TokenUrl", cognitoTokenUrl(domainPrefix, this.region));
    out("ClientId", client.userPoolClientId);
    out("Scope", READ_SCOPE);
    out("ClientSecretAlias", clientSecretAlias);
  }
}

interface BasyxFargateServiceProps {
  readonly service: BasyxService;
  readonly accessRules: string;
  readonly trustList: string;
  readonly cluster: ICluster;
  readonly database: IDatabaseCluster;
  readonly databaseSecret: ISecret;
  readonly namespace: PrivateDnsNamespace;
  readonly profile: DeploymentProfile;
  readonly securityGroup: ISecurityGroup;
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
    const retention =
      profile === "production"
        ? RetentionDays.ONE_MONTH
        : RetentionDays.ONE_WEEK;
    const logging = (name: string) =>
      LogDriver.awsLogs({
        logGroup: new LogGroup(this, `${name}LogGroup`, { retention }),
        mode: AwsLogDriverMode.NON_BLOCKING,
        streamPrefix: name,
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
      image: ContainerImage.fromRegistry(BASYX_IMAGES.configurationService),
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
      image: ContainerImage.fromRegistry(
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
        ...(service === "dtr" && {
          SERVER_CONTEXTPATH: DTR_CONTEXT_PATH,
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
      cloudMapOptions: {
        cloudMapNamespace: props.namespace,
        name,
        dnsRecordType: DnsRecordType.A,
        dnsTtl: Duration.seconds(10),
      },
    });
    // The cluster endpoint only resolves once the writer instance exists.
    fargateService.node.addDependency(props.database);
  }
}
