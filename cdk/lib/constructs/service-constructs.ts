// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from "constructs";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { ContainerImage } from "aws-cdk-lib/aws-ecs";

import {
  ControlPlanePortMapping,
  DataPlanePortMapping,
} from "../config/port-mappings";

import { InfraConstructs } from "./infra-constructs";
import { EdcControlPlane } from "./edc-control-plane";
import { EdcDataPlane } from "./edc-data-plane";

export interface ServiceConstructsProps {
  readonly apiAuthKey: string;
  readonly controlPlaneCpu: number;
  readonly controlPlaneMemoryLimitMiB: number;
  readonly controlPlanePolicyMonitorIteration: string;
  readonly controlPlanePortMapping: ControlPlanePortMapping;
  readonly dataPlaneCpu: number;
  readonly dataPlaneMemoryLimitMiB: number;
  readonly dataPlanePortMapping: DataPlanePortMapping;
  readonly ddbTables?: TableV2[];
  readonly edcIamEnvVars: { [key: string]: string };
  readonly infraConstructs: InfraConstructs;
}

export class ServiceConstructs extends Construct {
  constructor(scope: Construct, id: string, props: ServiceConstructsProps) {
    super(scope, id);

    const loggingPolicyStatement = new PolicyStatement({
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
      resources: ["arn:aws:logs:*"],
    });

    const secretsPolicyStatement = new PolicyStatement({
      actions: [
        "secretsmanager:CreateSecret",
        "secretsmanager:DeleteSecret",
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:UpdateSecret",
      ],
      effect: Effect.ALLOW,
      resources: ["arn:aws:secretsmanager:*"],
    });

    const s3PolicyStatement = new PolicyStatement({
      actions: [
        // Provider actions
        "s3:GetObject",
        "s3:ListBucket",
        // Consumer actions
        "s3:PutObject",
        "s3:AbortMultipartUpload",
        "s3:ListBucketMultipartUploads",
        "s3:ListMultipartUploadParts",
      ],
      effect: Effect.ALLOW,
      resources: [
        props.infraConstructs.s3Bucket.bucketArn,
        props.infraConstructs.s3Bucket.bucketArn + "/*",
      ],
    });

    const policyStatements = [
      loggingPolicyStatement,
      secretsPolicyStatement,
      s3PolicyStatement,
    ];

    const ddbActions = [
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
    ];

    if (props.ddbTables) {
      policyStatements.push(
        new PolicyStatement({
          actions: ddbActions,
          effect: Effect.ALLOW,
          resources: props.ddbTables.map((table) => table.tableArn + "*"),
        }),
      );
    }

    const controlPlane = new EdcControlPlane(scope, "ControlPlane", {
      apiAuthKey: props.apiAuthKey,
      cluster: props.infraConstructs.ecsCluster,
      cpu: props.controlPlaneCpu,
      dspCallbackAddress: props.infraConstructs.api.outputs.dspUrl,
      edcIamEnvVars: props.edcIamEnvVars,
      image: ContainerImage.fromDockerImageAsset(
        props.infraConstructs.controlPlaneImage,
      ),
      memoryLimitMiB: props.controlPlaneMemoryLimitMiB,
      nlbOutputs: props.infraConstructs.nlbOutputs,
      policyMonitorIteration: props.controlPlanePolicyMonitorIteration,
      portMapping: props.controlPlanePortMapping,
      taskRolePolicyStatements: policyStatements,
      vpc: props.infraConstructs.vpc,
    });

    const dataPlane = new EdcDataPlane(scope, "DataPlane", {
      apiPublicUrl: props.infraConstructs.api.outputs.dataPlaneUrl,
      cluster: props.infraConstructs.ecsCluster,
      controlPlanePortMapping: props.controlPlanePortMapping,
      cpu: props.dataPlaneCpu,
      dataPlanePortMapping: props.dataPlanePortMapping,
      edcIamEnvVars: props.edcIamEnvVars,
      image: ContainerImage.fromDockerImageAsset(
        props.infraConstructs.dataPlaneImage,
      ),
      memoryLimitMiB: props.dataPlaneMemoryLimitMiB,
      nlbOutputs: props.infraConstructs.nlbOutputs,
      taskRolePolicyStatements: policyStatements,
      vpc: props.infraConstructs.vpc,
    });
    dataPlane.node.addDependency(controlPlane);
  }
}
