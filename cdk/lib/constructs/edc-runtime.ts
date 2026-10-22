// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from "constructs";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { IVpc, Peer, Port, SecurityGroup } from "aws-cdk-lib/aws-ec2";
import { IApplicationTargetGroup } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  AwsLogDriverMode,
  ContainerImage,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  ICluster,
  LogDriver,
} from "aws-cdk-lib/aws-ecs";

import { DeploymentProfile } from "../config/config";

export interface EdcRuntimeProps {
  readonly cluster: ICluster;
  readonly vpc: IVpc;
  readonly profile: DeploymentProfile;
  readonly image: ContainerImage;
  readonly cpu: number;
  readonly memoryLimitMiB: number;
  /** Named ports; `default` serves `/api` and the health check, each other `/api/<name>`. */
  readonly ports: Readonly<Record<string, number>>;
  readonly environment: Record<string, string>;
  readonly taskRolePolicyStatements: PolicyStatement[];
  readonly albSecurityGroupId: string;
  /** Lets the task call the ALB control ports. */
  readonly taskSecurityGroupId: string;
  readonly targetGroups: Readonly<Record<number, IApplicationTargetGroup>>;
}

/** One EDC runtime (control or data plane) as a Fargate service behind the shared ALB. */
export class EdcRuntime extends Construct {
  constructor(scope: Construct, id: string, props: EdcRuntimeProps) {
    super(scope, id);
    const ports = Object.entries(props.ports);

    const securityGroup = new SecurityGroup(this, `${id}SecurityGroup`, {
      allowAllOutbound: false,
      vpc: props.vpc,
    });
    for (const [, port] of ports) {
      securityGroup.addIngressRule(
        Peer.securityGroupId(props.albSecurityGroupId),
        Port.tcp(port),
      );
    }
    securityGroup.addEgressRule(Peer.anyIpv4(), Port.HTTP);
    securityGroup.addEgressRule(Peer.anyIpv4(), Port.HTTPS);
    securityGroup.addEgressRule(Peer.anyIpv4(), Port.tcpRange(1024, 65535));

    const taskDefinition = new FargateTaskDefinition(this, "TaskDefinition", {
      cpu: props.cpu,
      memoryLimitMiB: props.memoryLimitMiB,
      runtimePlatform: { cpuArchitecture: CpuArchitecture.ARM64 },
    });
    props.taskRolePolicyStatements.forEach((s) =>
      taskDefinition.addToTaskRolePolicy(s),
    );

    const webHttp = Object.fromEntries(
      ports.flatMap(([name, port]) => {
        const key = name === "default" ? "web.http" : `web.http.${name}`;
        const path = name === "default" ? "/api" : `/api/${name}`;
        return [
          [`${key}.port`, `${port}`],
          [`${key}.path`, path],
        ];
      }),
    );

    taskDefinition.addContainer(`${id}Container`, {
      containerName: id,
      image: props.image,
      environment: { ...props.environment, ...webHttp },
      logging: LogDriver.awsLogs({
        logGroup: new LogGroup(this, "LogGroup", {
          retention:
            props.profile === "production"
              ? RetentionDays.ONE_MONTH
              : RetentionDays.ONE_WEEK,
        }),
        mode: AwsLogDriverMode.NON_BLOCKING,
        streamPrefix: `Edc${id}`,
      }),
      portMappings: ports.map(([name, port]) => ({
        name,
        containerPort: port,
        hostPort: port,
      })),
    });

    const service = new FargateService(this, `${id}FargateService`, {
      capacityProviderStrategies:
        props.profile === "development"
          ? [{ capacityProvider: "FARGATE_SPOT", weight: 1 }]
          : undefined,
      circuitBreaker: { enable: true, rollback: true },
      cluster: props.cluster,
      minHealthyPercent: 100,
      securityGroups: [
        securityGroup,
        SecurityGroup.fromSecurityGroupId(
          this,
          "EdcTaskSecurityGroup",
          props.taskSecurityGroupId,
        ),
      ],
      taskDefinition,
    });
    for (const [, port] of ports) {
      props.targetGroups[port].addTarget(
        service.loadBalancerTarget({ containerName: id, containerPort: port }),
      );
    }
  }
}
