// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from "constructs";
import { Stack } from "aws-cdk-lib";
import { IRole, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { LogGroup } from "aws-cdk-lib/aws-logs";

import { IVpc, Peer, Port, SecurityGroup } from "aws-cdk-lib/aws-ec2";

import {
  AwsLogDriverMode,
  ContainerImage,
  CpuArchitecture,
  FargateTaskDefinition,
  ICluster,
  LogDriver,
} from "aws-cdk-lib/aws-ecs";

import { EdcNlbOutputs } from "./edc-nlb";
import { EDC_SECRETS_MANAGER_ALIASES } from "../config/environments";
import { EdcFargateService } from "./edc-fargate-service";
import { ControlPlanePortMapping } from "../config/port-mappings";

export interface EdcControlPlaneProps {
  readonly apiAuthKey: string;
  readonly cluster: ICluster;
  readonly cpu: number;
  readonly dspCallbackAddress: string;
  readonly edcIamEnvVars: { [key: string]: string };
  readonly image: ContainerImage;
  readonly memoryLimitMiB: number;
  readonly nlbOutputs: EdcNlbOutputs;
  readonly policyMonitorIteration: string;
  readonly portMapping: ControlPlanePortMapping;
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
        Peer.securityGroupId(props.nlbOutputs.securityGroupId),
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
        cpuArchitecture: CpuArchitecture.X86_64,
      },
    });
    props.taskRolePolicyStatements.forEach((policyStatement) =>
      taskDefinition.addToTaskRolePolicy(policyStatement),
    );

    const containerName = "ControlPlane";

    taskDefinition.addContainer("ControlPlaneContainer", {
      containerName: containerName,
      environment: {
        "edc.dsp.callback.address": props.dspCallbackAddress,
        "edc.hostname": props.nlbOutputs.dnsName,
        "edc.iam.did.web.use.https": "true",
        "edc.iam.sts.oauth.client.secret.alias":
          EDC_SECRETS_MANAGER_ALIASES.OAUTH_CLIENT_SECRET,
        "edc.policy.monitor.state-machine.iteration-wait-millis":
          props.policyMonitorIteration,
        "edc.runtime.id": id,
        "edc.vault.aws.region": Stack.of(this).region,

        // This declares the aliases to use in AWS Secrets Manager for consumer pull scenarios
        "edc.transfer.proxy.token.signer.privatekey.alias":
          EDC_SECRETS_MANAGER_ALIASES.TOKEN_SIGNER_PRIVATE_KEY,
        "edc.transfer.proxy.token.verifier.publickey.alias":
          EDC_SECRETS_MANAGER_ALIASES.TOKEN_VERIFIER_PUBLIC_KEY,

        ...props.edcIamEnvVars,

        "web.http.port": `${props.portMapping.default}`,
        "web.http.path": "/api",
        "web.http.management.port": `${props.portMapping.management}`,
        "web.http.management.path": "/api/management",
        "web.http.management.auth.key": props.apiAuthKey,
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
        logGroup: new LogGroup(this, "LogGroup"),
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

    new EdcFargateService(this, "ControlPlaneFargateService", {
      cluster: props.cluster,
      containerName: containerName,
      securityGroups: [securityGroup],
      targetGroups: props.nlbOutputs.controlPlaneTargetGroups,
      taskDefinition: taskDefinition,
    });

    this.taskRole = taskDefinition.taskRole;
  }
}
