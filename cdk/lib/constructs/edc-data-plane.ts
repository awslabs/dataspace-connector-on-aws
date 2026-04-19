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

import {
  ControlPlanePortMapping,
  DataPlanePortMapping,
} from "../config/port-mappings";

import { EdcNlbOutputs } from "./edc-nlb";
import { EDC_SECRETS_MANAGER_ALIASES } from "../config/environments";
import { EdcFargateService } from "./edc-fargate-service";

export interface EdcDataPlaneProps {
  readonly apiPublicUrl: string;
  readonly cluster: ICluster;
  readonly controlPlanePortMapping: ControlPlanePortMapping;
  readonly cpu: number;
  readonly dataPlanePortMapping: DataPlanePortMapping;
  readonly edcIamEnvVars: { [key: string]: string };
  readonly image: ContainerImage;
  readonly memoryLimitMiB: number;
  readonly nlbOutputs: EdcNlbOutputs;
  readonly taskRolePolicyStatements: PolicyStatement[];
  readonly vpc: IVpc;
}

export class EdcDataPlane extends Construct {
  readonly taskRole: IRole;

  constructor(scope: Construct, id: string, props: EdcDataPlaneProps) {
    super(scope, id);

    const securityGroup = new SecurityGroup(this, "DataPlaneSecurityGroup", {
      allowAllOutbound: false,
      vpc: props.vpc,
    });
    Object.values(props.dataPlanePortMapping).forEach((port) =>
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

    const containerName = "DataPlane";

    taskDefinition.addContainer("DataPlaneContainer", {
      containerName: containerName,
      environment: {
        "edc.dataplane.api.public.baseurl": props.apiPublicUrl,
        "edc.dpf.selector.url": `http://${props.nlbOutputs.dnsName}:${props.controlPlanePortMapping.control}/api/control/v1/dataplanes`,
        "edc.hostname": props.nlbOutputs.dnsName,
        "edc.iam.did.web.use.https": "true",
        "edc.iam.sts.oauth.client.secret.alias":
          EDC_SECRETS_MANAGER_ALIASES.OAUTH_CLIENT_SECRET,
        "edc.runtime.id": id,
        "edc.vault.aws.region": Stack.of(this).region,
        "tx.edc.dataplane.token.refresh.endpoint": `${props.apiPublicUrl}token`,

        // This declares the aliases to use in AWS Secrets Manager for consumer pull scenarios
        "edc.transfer.proxy.token.signer.privatekey.alias":
          EDC_SECRETS_MANAGER_ALIASES.TOKEN_SIGNER_PRIVATE_KEY,
        "edc.transfer.proxy.token.verifier.publickey.alias":
          EDC_SECRETS_MANAGER_ALIASES.TOKEN_VERIFIER_PUBLIC_KEY,

        ...props.edcIamEnvVars,

        "web.http.port": `${props.dataPlanePortMapping.default}`,
        "web.http.path": "/api",
        "web.http.public.port": `${props.dataPlanePortMapping.public}`,
        "web.http.public.path": "/api/public",
        "web.http.control.port": `${props.dataPlanePortMapping.control}`,
        "web.http.control.path": "/api/control",

        JDK_JAVA_OPTIONS: [
          "--add-opens=java.base/java.util.concurrent=ALL-UNNAMED",
        ].join(" "),
      },
      image: props.image,
      logging: LogDriver.awsLogs({
        logGroup: new LogGroup(this, "LogGroup"),
        mode: AwsLogDriverMode.NON_BLOCKING,
        streamPrefix: "EdcDataPlane",
      }),
      portMappings: Object.entries(props.dataPlanePortMapping).map((entry) => {
        return {
          name: entry[0],
          containerPort: entry[1],
          hostPort: entry[1],
        };
      }),
    });

    new EdcFargateService(this, "DataPlaneFargateService", {
      cluster: props.cluster,
      containerName: containerName,
      securityGroups: [securityGroup],
      targetGroups: props.nlbOutputs.dataPlaneTargetGroups,
      taskDefinition: taskDefinition,
    });

    this.taskRole = taskDefinition.taskRole;
  }
}
