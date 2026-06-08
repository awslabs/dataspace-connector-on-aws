// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from "constructs";
import { ISecurityGroup } from "aws-cdk-lib/aws-ec2";
import { IApplicationTargetGroup } from "aws-cdk-lib/aws-elasticloadbalancingv2";

import {
  FargatePlatformVersion,
  FargateService,
  ICluster,
  TaskDefinition,
} from "aws-cdk-lib/aws-ecs";

import { DeploymentProfile } from "../config/environments";

export interface EdcFargateServiceProps {
  readonly cluster: ICluster;
  readonly containerName: string;
  readonly containerPort: number;
  readonly maxHealthyPercent?: number;
  readonly minHealthyPercent?: number;
  readonly profile: DeploymentProfile;
  readonly securityGroups: ISecurityGroup[];
  readonly targetGroup: IApplicationTargetGroup;
  readonly taskDefinition: TaskDefinition;
}

export class EdcFargateService extends FargateService {
  constructor(scope: Construct, id: string, props: EdcFargateServiceProps) {
    super(scope, id, {
      capacityProviderStrategies:
        props.profile === "development"
          ? [{ capacityProvider: "FARGATE_SPOT", weight: 1 }]
          : undefined,
      circuitBreaker: { enable: true },
      cluster: props.cluster,
      maxHealthyPercent: props.maxHealthyPercent || 200,
      minHealthyPercent: props.minHealthyPercent || 100,
      platformVersion: FargatePlatformVersion.LATEST,
      securityGroups: props.securityGroups,
      taskDefinition: props.taskDefinition,
    });

    props.targetGroup.addTarget(
      this.loadBalancerTarget({
        containerName: props.containerName,
        containerPort: props.containerPort,
      }),
    );
  }
}
