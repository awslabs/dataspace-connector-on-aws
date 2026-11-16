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
  ApplicationProtocol,
  ApplicationTargetGroup,
  CfnListenerRule,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";
import { DockerImageAsset } from "aws-cdk-lib/aws-ecr-assets";
import { ContainerImage, Secret as EcsSecret } from "aws-cdk-lib/aws-ecs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";

import {
  ConnectorYaml,
  DeploymentYaml,
  PersistenceType,
  connectorBpnl,
  deriveAdminSecretName,
  deriveConnectorClusterIdentifier,
  deriveConnectorTableName,
  deriveSecretPrefix,
  edcIdentityEnvironment,
  toRemovalPolicy,
  validateClusterIdentifier,
} from "./config/config";
import {
  CONTROL_PLANE_PORTS as cpPorts,
  DATA_PLANE_PORTS as dpPorts,
} from "./config/port-mappings";
import { EdcAurora } from "./constructs/edc-aurora";
import { EdcDdb } from "./constructs/edc-ddb";
import { EdcRuntime } from "./constructs/edc-runtime";
import { EdcTokenKeyPair } from "./constructs/edc-token-key-pair";
import { PortalConnector } from "./constructs/portal-connector";
import { SharedInfraStack } from "./shared-infra-stack";

export interface ConnectorStackProps extends StackProps {
  readonly connector: ConnectorYaml;
  readonly deployment: DeploymentYaml;
  readonly sharedInfra: SharedInfraStack;
  readonly priority: number;
  readonly deploymentName: string;
}

/** EDC vault aliases, under the connector's secret prefix. */
const OAUTH_CLIENT_SECRET = "edc.iam.sts.oauth.client.secret";
const TOKEN_SIGNER_PRIVATE_KEY = "edc.transfer.proxy.token.private-key";
const TOKEN_VERIFIER_PUBLIC_KEY = "edc.transfer.proxy.token.public-key";

/**
 * Both planes of an Aurora connector run the Tractus-X Flyway migration at
 * boot, against the same database and schema. Concurrent runs serialize on
 * Flyway's lock.
 */
const MIGRATION_SCHEMA = "public";

/**
 * Covers an Aurora resume from auto-pause plus the first boot's schema migration,
 * during which the load balancer health check fails.
 */
const AURORA_HEALTH_CHECK_GRACE_PERIOD = Duration.minutes(5);

/** The image of one plane for a persistence type, which the shared infrastructure builds if a connector uses it. */
function runtimeImage(
  images: Partial<Record<PersistenceType, DockerImageAsset>>,
  persistence: PersistenceType,
  plane: string,
): ContainerImage {
  const asset = images[persistence];
  if (!asset) {
    throw new Error(
      `No ${plane} image is built for persistence "${persistence}"; the shared infrastructure builds images only for the persistence types of the configured connectors`,
    );
  }
  return ContainerImage.fromDockerImageAsset(asset);
}

export class ConnectorStack extends Stack {
  constructor(scope: Construct, id: string, props: ConnectorStackProps) {
    super(scope, id, props);

    const { connector, deployment, sharedInfra: infra, deploymentName } = props;
    const connectorId = connector.connectorId;
    const profile = connector.profile;
    const logLevel = connector.logLevel;
    const interactiveMillis = `${connector.interactiveStateMachineIterationMillis}`;
    const backgroundMillis = `${connector.backgroundStateMachineIterationMillis}`;
    const removalPolicy = toRemovalPolicy(connector.stateRemovalPolicy);
    const secretPrefix = deriveSecretPrefix(deploymentName, connectorId);
    const dspUrl = `${infra.dspUrl}${connectorId}`;

    const persistence = connector.persistence;
    let ddb: EdcDdb | undefined;
    let aurora: EdcAurora | undefined;
    if (persistence === "aurora") {
      validateClusterIdentifier(deploymentName, connectorId);
      aurora = new EdcAurora(this, "EdcAurora", {
        clusterIdentifier: deriveConnectorClusterIdentifier(
          deploymentName,
          connectorId,
        ),
        profile,
        removalPolicy,
        vpc: infra.vpc,
      });
    } else {
      ddb = new EdcDdb(this, "EdcDdb", {
        removalPolicy,
        tableName: deriveConnectorTableName(deploymentName, connectorId),
      });
    }

    const s3Bucket = new Bucket(this, "DataPlaneBucket", {
      autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
    });

    const oauthSecret = new Secret(this, "EdcOauthClientSecret", {
      secretName: `${secretPrefix}${OAUTH_CLIENT_SECRET}`,
      description: `EDC OAuth client secret for connector ${connectorId}`,
    });

    // Registers the connector at the portal and creates its technical user.
    const bpnl = connectorBpnl(deployment, connector);
    const portal = new PortalConnector(this, "PortalConnector", {
      serviceToken: infra.portalConnectorServiceToken,
      properties: {
        Environment: deployment.portal.environment,
        Bpnl: bpnl,
        ConnectorName: connectorId,
        ConnectorUrl: dspUrl,
        TechnicalUserName: `${deploymentName}-${connectorId}`,
        AdminSecretName: deriveAdminSecretName(deploymentName, bpnl),
        OauthSecretName: oauthSecret.secretName,
      },
    });
    portal.node.addDependency(oauthSecret);

    const tokenKeyPair = new EdcTokenKeyPair(this, "TokenKeyPair", {
      serviceToken: infra.tokenKeyPairServiceToken,
      privateKeySecretName: `${secretPrefix}${TOKEN_SIGNER_PRIVATE_KEY}`,
      publicKeySecretName: `${secretPrefix}${TOKEN_VERIFIER_PUBLIC_KEY}`,
    });

    // One target group and listener rule per port; the ALB strips the connector path.
    const targetGroups: Record<number, ApplicationTargetGroup> = {};
    const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);
    const targets = [
      ...Object.entries(cpPorts).map(([n, p]) => [
        `Cp${capitalize(n)}`,
        p,
        cpPorts.default,
      ]),
      ...Object.entries(dpPorts).map(([n, p]) => [
        `Dp${capitalize(n)}`,
        p,
        dpPorts.default,
      ]),
    ] as [string, number, number][];
    for (const [id, port, healthPort] of targets) {
      const tg = new ApplicationTargetGroup(this, `${id}TargetGroup`, {
        port,
        protocol: ApplicationProtocol.HTTP,
        targetType: TargetType.IP,
        vpc: infra.vpc,
        healthCheck: { path: "/api/check/health", port: `${healthPort}` },
      });
      targetGroups[port] = tg;

      new CfnListenerRule(this, `${id}ListenerRule`, {
        actions: [{ type: "forward", targetGroupArn: tg.targetGroupArn }],
        conditions: [
          {
            field: "path-pattern",
            pathPatternConfig: { values: [`/${connectorId}/*`] },
          },
        ],
        listenerArn: infra.listenerArns[port],
        priority: props.priority,
        transforms: [
          {
            type: "url-rewrite",
            urlRewriteConfig: {
              rewrites: [{ regex: `^/${connectorId}/(.*)$`, replace: "/$1" }],
            },
          },
        ],
      });
    }

    const arn = (service: string) =>
      `arn:aws:${service}:${this.region}:${this.account}`;
    const taskRolePolicyStatements = [
      new PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        effect: Effect.ALLOW,
        resources: [
          `${arn("logs")}:log-group:${deploymentName}-${connectorId}*:*`,
        ],
      }),
      new PolicyStatement({
        actions: [
          "secretsmanager:CreateSecret",
          "secretsmanager:DeleteSecret",
          "secretsmanager:GetSecretValue",
          "secretsmanager:UpdateSecret",
        ],
        effect: Effect.ALLOW,
        // The connector's own secrets, and the EDRs and refresh tokens EDC stores.
        resources: [
          `${arn("secretsmanager")}:secret:${secretPrefix}*`,
          `${arn("secretsmanager")}:secret:edr--*`,
          `${arn("secretsmanager")}:secret:????????-????-????-????-????????????-*`,
        ],
      }),
      new PolicyStatement({
        actions: [
          "s3:GetObject",
          "s3:ListBucket",
          "s3:PutObject",
          "s3:AbortMultipartUpload",
          "s3:ListBucketMultipartUploads",
          "s3:ListMultipartUploadParts",
        ],
        effect: Effect.ALLOW,
        resources: [s3Bucket.bucketArn, `${s3Bucket.bucketArn}/*`],
      }),
      ...(ddb
        ? [
            new PolicyStatement({
              actions: [
                "dynamodb:BatchGetItem",
                "dynamodb:BatchWriteItem",
                "dynamodb:ConditionCheckItem",
                "dynamodb:DeleteItem",
                "dynamodb:DescribeTable",
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:Query",
                "dynamodb:UpdateItem",
              ],
              effect: Effect.ALLOW,
              resources: [ddb.table.tableArn, `${ddb.table.tableArn}/index/*`],
            }),
          ]
        : []),
    ];

    const alb = infra.albDnsName;
    const identity = edcIdentityEnvironment(
      deployment.portal.environment,
      bpnl,
      portal,
    );
    const environment = {
      ...identity,
      // Points the S3 extension's static-credential probe at the connector's own
      // (nonexistent) secrets, so it resolves not-found and uses the task role.
      "edc.aws.access.key": `${secretPrefix}edc.aws.access.key`,
      "edc.aws.secret.access.key": `${secretPrefix}edc.aws.secret.access.key`,
      ...(ddb && { "edc.ddb.table.name": ddb.table.tableName }),
      "edc.hostname": alb,
      "edc.iam.did.web.use.https": "true",
      "edc.iam.sts.oauth.client.secret.alias": `${secretPrefix}${OAUTH_CLIENT_SECRET}`,
      "edc.runtime.id": connectorId,
      "edc.transfer.proxy.token.signer.privatekey.alias": `${secretPrefix}${TOKEN_SIGNER_PRIVATE_KEY}`,
      "edc.transfer.proxy.token.verifier.publickey.alias": `${secretPrefix}${TOKEN_VERIFIER_PUBLIC_KEY}`,
      "edc.vault.aws.region": this.region,
      ...(logLevel && { EDC_LOG_LEVEL: logLevel }),
      ...(aurora && {
        "edc.datasource.default.url": aurora.jdbcUrl,
        // connector-migration refuses to boot without it, and the value must
        // never change once set, so it is the participant id, which never does.
        "edc.participant.context.id": identity["edc.participant.id"],
        "tx.edc.postgresql.migration.enabled": "true",
        "tx.edc.postgresql.migration.schema": MIGRATION_SCHEMA,
      }),
    };
    const common = {
      cluster: infra.ecsCluster,
      vpc: infra.vpc,
      profile,
      taskRolePolicyStatements,
      albSecurityGroupId: infra.albSecurityGroupId,
      taskSecurityGroupId: infra.edcTaskSecurityGroupId,
      targetGroups,
      // The user name and password reach the container as ECS secrets, not
      // through the vault: vault aliases are account-global, and the task role
      // reads only this connector's prefix.
      ...(aurora && {
        healthCheckGracePeriod: AURORA_HEALTH_CHECK_GRACE_PERIOD,
        secrets: {
          EDC_DATASOURCE_DEFAULT_USER: EcsSecret.fromSecretsManager(
            aurora.secret,
            "username",
          ),
          EDC_DATASOURCE_DEFAULT_PASSWORD: EcsSecret.fromSecretsManager(
            aurora.secret,
            "password",
          ),
        },
      }),
    };

    const controlPlane = new EdcRuntime(this, "ControlPlane", {
      ...common,
      image: runtimeImage(
        infra.controlPlaneImages,
        persistence,
        "control plane",
      ),
      cpu: connector.controlPlaneCpu,
      memoryLimitMiB: connector.controlPlaneMemoryLimitMiB,
      ports: cpPorts,
      environment: {
        ...environment,
        "edc.dsp.callback.address": dspUrl,
        "edc.negotiation.consumer.state-machine.iteration-wait-millis":
          interactiveMillis,
        "edc.negotiation.provider.state-machine.iteration-wait-millis":
          interactiveMillis,
        "edc.transfer.state-machine.iteration-wait-millis": interactiveMillis,
        "edc.policy.monitor.state-machine.iteration-wait-millis":
          backgroundMillis,
        "edc.data.plane.selector.state-machine.iteration-wait-millis":
          backgroundMillis,
      },
    });

    const dataPlanePublicUrl = `${infra.dataPlaneUrl}${connectorId}/`;
    const dataPlane = new EdcRuntime(this, "DataPlane", {
      ...common,
      image: runtimeImage(infra.dataPlaneImages, persistence, "data plane"),
      cpu: connector.dataPlaneCpu,
      memoryLimitMiB: connector.dataPlaneMemoryLimitMiB,
      ports: dpPorts,
      environment: {
        ...environment,
        "edc.control.endpoint": `http://${alb}:${dpPorts.control}/${connectorId}/api/control`,
        "edc.dataplane.api.public.baseurl": dataPlanePublicUrl,
        "edc.dataplane.state-machine.iteration-wait-millis": interactiveMillis,
        "edc.dataplane.state-machine.flow.lease.time": `${connector.dataPlaneFlowLeaseMillis}`,
        "edc.dpf.selector.url": `http://${alb}:${cpPorts.control}/${connectorId}/api/control/v1/dataplanes`,
        "tx.edc.dataplane.token.refresh.endpoint": `${dataPlanePublicUrl}token`,
      },
    });
    controlPlane.node.addDependency(tokenKeyPair);
    dataPlane.node.addDependency(controlPlane);

    if (aurora) {
      // Each service waits for the cluster and for the rule admitting its own
      // tasks, but not for the other plane's rule (see EdcAurora.allowFrom).
      for (const [runtime, name, label] of [
        [controlPlane, "ControlPlane", "control plane"],
        [dataPlane, "DataPlane", "data plane"],
      ] as const) {
        runtime.service.node.addDependency(
          aurora.cluster,
          aurora.allowFrom(
            `AllowFrom${name}`,
            runtime.securityGroup,
            `EDC ${label}`,
          ),
        );
      }
    }

    new CfnOutput(this, "EdcDataPlaneBucketName", {
      value: s3Bucket.bucketName,
    });
    if (aurora) {
      new CfnOutput(this, "EdcAuroraClusterEndpoint", {
        value: aurora.cluster.clusterEndpoint.hostname,
      });
      new CfnOutput(this, "EdcAuroraSecretArn", {
        value: aurora.secret.secretArn,
      });
    }
  }
}
