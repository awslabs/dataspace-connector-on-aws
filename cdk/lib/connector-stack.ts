// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

import {
  ApplicationProtocol,
  ApplicationTargetGroup,
  CfnListenerRule,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";

import { ContainerImage } from "aws-cdk-lib/aws-ecs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";

import {
  ConnectorConfig,
  EDC_SECRETS_MANAGER_ALIASES,
  SharedInfraConfig,
} from "./config/environments";

import { EdcControlPlane } from "./constructs/edc-control-plane";
import { EdcDataPlane } from "./constructs/edc-data-plane";
import { EdcDdb } from "./constructs/edc-ddb";
import { EdcTokenKeyPair } from "./constructs/edc-token-key-pair";

import { SharedInfraStack } from "./shared-infra-stack";

export interface ConnectorStackProps extends StackProps {
  readonly connectorConfig: ConnectorConfig;
  readonly sharedInfra: SharedInfraStack;
  readonly sharedInfraConfig: SharedInfraConfig;
  readonly priority: number;
}

export class ConnectorStack extends Stack {
  constructor(scope: Construct, id: string, props: ConnectorStackProps) {
    super(scope, id, props);

    const config = props.connectorConfig;
    const infra = props.sharedInfra;
    const infraConfig = props.sharedInfraConfig;
    const connectorId = config.connectorId;
    const profile = config.profile ?? infraConfig.profile;

    // Per-connector DDB tables
    const ddb = new EdcDdb(this, "EdcDdb", {
      encryptionKey: undefined,
      removalPolicy: config.edcStateRemovalPolicy,
    });

    // Per-connector S3 bucket
    const s3Bucket = new Bucket(this, "DataPlaneBucket", {
      enforceSSL: true,
      removalPolicy: config.edcStateRemovalPolicy,
    });

    // Per-connector secrets
    const secretPrefix = `${connectorId}/`;
    new Secret(this, "EdcOauthClientSecret", {
      secretName: `${secretPrefix}${EDC_SECRETS_MANAGER_ALIASES.DCP_STS_OAUTH_CLIENT_SECRET_ALIAS}`,
      description: `EDC OAuth client secret for connector ${connectorId}`,
    });

    new EdcTokenKeyPair(this, "EdcTokenKeyPair", {
      privateKeySecretName: `${secretPrefix}${EDC_SECRETS_MANAGER_ALIASES.TOKEN_SIGNER_PRIVATE_KEY}`,
      publicKeySecretName: `${secretPrefix}${EDC_SECRETS_MANAGER_ALIASES.TOKEN_VERIFIER_PUBLIC_KEY}`,
    });

    // ALB target groups and listener rules — one per EDC port
    const cpPorts = infraConfig.controlPlanePortMapping;
    const dpPorts = infraConfig.dataPlanePortMapping;

    const portConfigs: { name: string; port: number; healthPort: number; plane: "cp" | "dp" }[] = [
      { name: "CpDefault", port: cpPorts.default, healthPort: cpPorts.default, plane: "cp" },
      { name: "CpManagement", port: cpPorts.management, healthPort: cpPorts.default, plane: "cp" },
      { name: "CpProtocol", port: cpPorts.protocol, healthPort: cpPorts.default, plane: "cp" },
      { name: "CpControl", port: cpPorts.control, healthPort: cpPorts.default, plane: "cp" },
      { name: "DpDefault", port: dpPorts.default, healthPort: dpPorts.default, plane: "dp" },
      { name: "DpPublic", port: dpPorts.public, healthPort: dpPorts.default, plane: "dp" },
      { name: "DpControl", port: dpPorts.control, healthPort: dpPorts.default, plane: "dp" },
    ];

    const targetGroups: { [port: number]: ApplicationTargetGroup } = {};

    for (const pc of portConfigs) {
      const tg = new ApplicationTargetGroup(this, `${pc.name}TargetGroup`, {
        port: pc.port,
        protocol: ApplicationProtocol.HTTP,
        targetType: TargetType.IP,
        vpc: infra.vpc,
        healthCheck: {
          path: "/api/check/health",
          port: `${pc.healthPort}`,
        },
      });
      targetGroups[pc.port] = tg;

      new CfnListenerRule(this, `${pc.name}ListenerRule`, {
        actions: [{ type: "forward", targetGroupArn: tg.targetGroupArn }],
        conditions: [{ field: "path-pattern", pathPatternConfig: { values: [`/${connectorId}/*`] } }],
        listenerArn: infra.listenerArns[pc.port],
        priority: props.priority,
        transforms: [{
          type: "url-rewrite",
          urlRewriteConfig: { rewrites: [{ regex: `^/${connectorId}/(.*)$`, replace: "/$1" }] },
        }],
      });
    }

    // IAM policies
    const logsArn = `arn:aws:logs:${this.region}:${this.account}`;
    const secretArn = `arn:aws:secretsmanager:${this.region}:${this.account}:secret`;

    const policyStatements = [
      new PolicyStatement({
        actions: [
          "logs:CreateLogStream",
          "logs:CreateLogGroup",
          "logs:Describe*",
          "logs:Get*",
          "logs:Filter*",
          "logs:List*",
          "logs:Put*",
        ],
        effect: Effect.ALLOW,
        resources: [`${logsArn}:*`],
      }),
      new PolicyStatement({
        actions: [
          "secretsmanager:CreateSecret",
          "secretsmanager:DeleteSecret",
          "secretsmanager:DescribeSecret",
          "secretsmanager:GetSecretValue",
          "secretsmanager:UpdateSecret",
        ],
        effect: Effect.ALLOW,
        resources: [
          `${secretArn}:${connectorId}/*`,
          `${secretArn}:edr--*`,
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
        resources: [s3Bucket.bucketArn, s3Bucket.bucketArn + "/*"],
      }),
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
          "dynamodb:Scan",
          "dynamodb:UpdateItem",
        ],
        effect: Effect.ALLOW,
        resources: ddb.tables.map((t) => t.tableArn + "*"),
      }),
    ];

    // DSP callback and data plane public URL include connectorId
    const dspCallbackAddress = `${infra.dspUrl}${connectorId}`;
    const dataPlanePublicUrl = `${infra.dataPlaneUrl}${connectorId}/`;

    const albOutputs = {
      dnsName: infra.albDnsName,
      securityGroupId: infra.albSecurityGroupId,
      targetGroups,
    };

    // ECS services
    const controlPlane = new EdcControlPlane(this, "ControlPlane", {
      albOutputs,
      cluster: infra.ecsCluster,
      connectorId,
      cpu: config.controlPlaneCpu,
      dspCallbackAddress,
      edcIamEnvVars: config.edcIam,
      image: ContainerImage.fromDockerImageAsset(infra.controlPlaneImage),
      memoryLimitMiB: config.controlPlaneMemoryLimitMiB,
      secretPrefix,
      stateMachineIterationMillis: config.stateMachineIterationMillis,
      portMapping: infraConfig.controlPlanePortMapping,
      profile,
      taskRolePolicyStatements: policyStatements,
      vpc: infra.vpc,
    });

    const dataPlane = new EdcDataPlane(this, "DataPlane", {
      albOutputs,
      apiPublicUrl: dataPlanePublicUrl,
      cluster: infra.ecsCluster,
      connectorId,
      controlPlanePortMapping: infraConfig.controlPlanePortMapping,
      cpu: config.dataPlaneCpu,
      dataPlanePortMapping: infraConfig.dataPlanePortMapping,
      edcIamEnvVars: config.edcIam,
      image: ContainerImage.fromDockerImageAsset(infra.dataPlaneImage),
      memoryLimitMiB: config.dataPlaneMemoryLimitMiB,
      profile,
      secretPrefix,
      stateMachineIterationMillis: config.stateMachineIterationMillis,
      taskRolePolicyStatements: policyStatements,
      vpc: infra.vpc,
    });
    dataPlane.node.addDependency(controlPlane);
  }
}
