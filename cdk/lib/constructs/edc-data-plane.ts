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

import {
  CONTROL_PLANE_PORT_MAPPING_DEFAULT,
  DATA_PLANE_PORT_MAPPING_DEFAULT,
  AlbOutputs,
} from "../config/port-mappings";

import {
  EDC_SECRETS_MANAGER_ALIASES,
  DeploymentProfile,
} from "../config/config";
import { EdcFargateService } from "./edc-fargate-service";

export interface EdcDataPlaneProps {
  readonly albOutputs: AlbOutputs;
  readonly apiPublicUrl: string;
  readonly cluster: ICluster;
  readonly connectorId: string;
  readonly cpu: number;
  readonly ddbTableName: string;
  readonly edcIamEnvVars: { [key: string]: string };
  readonly image: ContainerImage;
  readonly memoryLimitMiB: number;
  readonly profile: DeploymentProfile;
  readonly secretPrefix: string;
  readonly dataPlaneStateMachineIterationMillis: string;
  readonly taskRolePolicyStatements: PolicyStatement[];
  readonly vpc: IVpc;
}

export class EdcDataPlane extends Construct {
  readonly taskRole: IRole;

  constructor(scope: Construct, id: string, props: EdcDataPlaneProps) {
    super(scope, id);

    const controlPlanePortMapping = CONTROL_PLANE_PORT_MAPPING_DEFAULT;
    const dataPlanePortMapping = DATA_PLANE_PORT_MAPPING_DEFAULT;

    const securityGroup = new SecurityGroup(this, "DataPlaneSecurityGroup", {
      allowAllOutbound: false,
      vpc: props.vpc,
    });
    Object.values(dataPlanePortMapping).forEach((port) =>
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

    const containerName = "DataPlane";

    taskDefinition.addContainer("DataPlaneContainer", {
      containerName: containerName,
      environment: {
        // Point the S3 extension's static-credential probe at the connector's own
        // (nonexistent) secret namespace so it resolves not-found and uses the task role.
        "edc.aws.access.key": `${props.secretPrefix}edc.aws.access.key`,
        "edc.aws.secret.access.key": `${props.secretPrefix}edc.aws.secret.access.key`,
        "edc.control.endpoint": `http://${props.albOutputs.dnsName}:${dataPlanePortMapping.control}/${props.connectorId}/api/control`,
        "edc.dataplane.api.public.baseurl": props.apiPublicUrl,
        "edc.dataplane.state-machine.iteration-wait-millis":
          props.dataPlaneStateMachineIterationMillis,
        "edc.ddb.table.name": props.ddbTableName,
        "edc.dpf.selector.url": `http://${props.albOutputs.dnsName}:${controlPlanePortMapping.control}/${props.connectorId}/api/control/v1/dataplanes`,
        "edc.hostname": props.albOutputs.dnsName,
        "edc.iam.did.web.use.https": "true",
        "edc.iam.sts.oauth.client.secret.alias": `${props.secretPrefix}${EDC_SECRETS_MANAGER_ALIASES.DCP_STS_OAUTH_CLIENT_SECRET_ALIAS}`,
        "edc.runtime.id": props.connectorId,
        "edc.vault.aws.region": Stack.of(this).region,
        "tx.edc.dataplane.token.refresh.endpoint": `${props.apiPublicUrl}token`,

        // This declares the aliases to use in AWS Secrets Manager for consumer pull scenarios
        "edc.transfer.proxy.token.signer.privatekey.alias": `${props.secretPrefix}${EDC_SECRETS_MANAGER_ALIASES.TOKEN_SIGNER_PRIVATE_KEY}`,
        "edc.transfer.proxy.token.verifier.publickey.alias": `${props.secretPrefix}${EDC_SECRETS_MANAGER_ALIASES.TOKEN_VERIFIER_PUBLIC_KEY}`,

        ...props.edcIamEnvVars,
        "edc.participant.id": props.edcIamEnvVars["edc.iam.issuer.id"],

        "web.http.port": `${dataPlanePortMapping.default}`,
        "web.http.path": "/api",
        "web.http.public.port": `${dataPlanePortMapping.public}`,
        "web.http.public.path": "/api/public",
        "web.http.control.port": `${dataPlanePortMapping.control}`,
        "web.http.control.path": "/api/control",

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
        streamPrefix: "EdcDataPlane",
      }),
      portMappings: Object.entries(dataPlanePortMapping).map((entry) => {
        return {
          name: entry[0],
          containerPort: entry[1],
          hostPort: entry[1],
        };
      }),
    });

    const service = new EdcFargateService(this, "DataPlaneFargateService", {
      cluster: props.cluster,
      containerName: containerName,
      containerPort: dataPlanePortMapping.default,
      profile: props.profile,
      securityGroups: [securityGroup],
      targetGroup: props.albOutputs.targetGroups[dataPlanePortMapping.default],
      taskDefinition: taskDefinition,
    });

    for (const port of Object.values(dataPlanePortMapping)) {
      if (port === dataPlanePortMapping.default) continue;
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
