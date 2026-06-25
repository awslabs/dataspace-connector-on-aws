// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from "constructs";
import { Stack } from "aws-cdk-lib";
import { IRole, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";

import { IVpc, Peer, Port, SecurityGroup } from "aws-cdk-lib/aws-ec2";

import {
  AwsLogDriverMode,
  ContainerImage,
  CpuArchitecture,
  FargateTaskDefinition,
  ICluster,
  LogDriver,
} from "aws-cdk-lib/aws-ecs";

import { IApplicationTargetGroup } from "aws-cdk-lib/aws-elasticloadbalancingv2";

export interface AlbOutputs {
  readonly dnsName: string;
  readonly securityGroupId: string;
  readonly targetGroups: { [port: number]: IApplicationTargetGroup };
}

import { EDC_SECRETS_MANAGER_ALIASES } from "../config/environments";
import { EdcFargateService } from "./edc-fargate-service";
import { ControlPlanePortMapping } from "../config/port-mappings";
import { DeploymentProfile } from "../config/environments";

export interface EdcControlPlaneProps {
  readonly albOutputs: AlbOutputs;
  readonly cluster: ICluster;
  readonly connectorId: string;
  readonly cpu: number;
  readonly ddbTableName: string;
  readonly dspCallbackAddress: string;
  readonly edcIamEnvVars: { [key: string]: string };
  readonly image: ContainerImage;
  readonly memoryLimitMiB: number;
  readonly secretPrefix: string;
  readonly stateMachineIterationMillis: string;
  readonly portMapping: ControlPlanePortMapping;
  readonly profile: DeploymentProfile;
  readonly taskRolePolicyStatements: PolicyStatement[];
  readonly vpc: IVpc;
}

export class EdcControlPlane extends Construct {
  readonly taskRole: IRole;

  constructor(scope: Construct, id: string, props: EdcControlPlaneProps) {
    super(scope, id);

    const securityGroup = new SecurityGroup(this, "ControlPlaneSecurityGroup", {
      allowAllOutbound: false,
      vpc: props.vpc,
    });
    Object.values(props.portMapping).forEach((port) =>
      securityGroup.addIngressRule(
        Peer.securityGroupId(props.albOutputs.securityGroupId),
        Port.tcp(port),
      ),
    );
    securityGroup.addEgressRule(Peer.anyIpv4(), Port.HTTP);
    securityGroup.addEgressRule(Peer.anyIpv4(), Port.HTTPS);
    securityGroup.addEgressRule(Peer.anyIpv4(), Port.tcpRange(1024, 65535));

    const taskDefinition = new FargateTaskDefinition(this, "TaskDefinition", {
      cpu: props.cpu,
      memoryLimitMiB: props.memoryLimitMiB,
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.ARM64,
      },
    });
    props.taskRolePolicyStatements.forEach((policyStatement) =>
      taskDefinition.addToTaskRolePolicy(policyStatement),
    );

    const containerName = "ControlPlane";

    taskDefinition.addContainer("ControlPlaneContainer", {
      containerName: containerName,
      environment: {
        "edc.ddb.table.name": props.ddbTableName,
        "edc.dsp.callback.address": props.dspCallbackAddress,
        "edc.hostname": props.albOutputs.dnsName,
        "edc.iam.did.web.use.https": "true",
        "edc.iam.sts.oauth.client.secret.alias": `${props.secretPrefix}${EDC_SECRETS_MANAGER_ALIASES.DCP_STS_OAUTH_CLIENT_SECRET_ALIAS}`,
        "edc.negotiation.consumer.state-machine.iteration-wait-millis":
          props.stateMachineIterationMillis,
        "edc.negotiation.provider.state-machine.iteration-wait-millis":
          props.stateMachineIterationMillis,
        "edc.policy.monitor.state-machine.iteration-wait-millis":
          props.stateMachineIterationMillis,
        "edc.transfer.state-machine.iteration-wait-millis":
          props.stateMachineIterationMillis,
        "edc.runtime.id": props.connectorId,
        "edc.vault.aws.region": Stack.of(this).region,

        // This declares the aliases to use in AWS Secrets Manager for consumer pull scenarios
        "edc.transfer.proxy.token.signer.privatekey.alias": `${props.secretPrefix}${EDC_SECRETS_MANAGER_ALIASES.TOKEN_SIGNER_PRIVATE_KEY}`,
        "edc.transfer.proxy.token.verifier.publickey.alias": `${props.secretPrefix}${EDC_SECRETS_MANAGER_ALIASES.TOKEN_VERIFIER_PUBLIC_KEY}`,

        ...props.edcIamEnvVars,
        "edc.participant.id": props.edcIamEnvVars["edc.iam.issuer.id"],

        "web.http.port": `${props.portMapping.default}`,
        "web.http.path": "/api",
        "web.http.management.port": `${props.portMapping.management}`,
        "web.http.management.path": "/api/management",
        "web.http.control.port": `${props.portMapping.control}`,
        "web.http.control.path": "/api/control",
        "web.http.protocol.port": `${props.portMapping.protocol}`,
        "web.http.protocol.path": "/api/protocol",

        JDK_JAVA_OPTIONS: [
          "--add-opens=java.base/java.util.concurrent=ALL-UNNAMED",
        ].join(" "),
      },
      image: props.image,
      logging: LogDriver.awsLogs({
        logGroup: new LogGroup(this, "LogGroup", {
          retention:
            props.profile === "production"
              ? RetentionDays.ONE_MONTH
              : RetentionDays.ONE_WEEK,
        }),
        mode: AwsLogDriverMode.NON_BLOCKING,
        streamPrefix: "EdcControlPlane",
      }),
      portMappings: Object.entries(props.portMapping).map((entry) => {
        return {
          name: entry[0],
          containerPort: entry[1],
          hostPort: entry[1],
        };
      }),
    });

    const service = new EdcFargateService(this, "ControlPlaneFargateService", {
      cluster: props.cluster,
      containerName: containerName,
      containerPort: props.portMapping.default,
      profile: props.profile,
      securityGroups: [securityGroup],
      targetGroup: props.albOutputs.targetGroups[props.portMapping.default],
      taskDefinition: taskDefinition,
    });

    // Register on all other CP target groups
    for (const port of Object.values(props.portMapping)) {
      if (port === props.portMapping.default) continue;
      const tg = props.albOutputs.targetGroups[port];
      if (tg) {
        tg.addTarget(
          service.loadBalancerTarget({ containerName, containerPort: port }),
        );
      }
    }

    this.taskRole = taskDefinition.taskRole;
  }
}
