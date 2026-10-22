// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "path";
import { CfnOutput, IgnoreMode, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { HostedZone } from "aws-cdk-lib/aws-route53";

import {
  GatewayVpcEndpointAwsService,
  IpAddresses,
  IVpc,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";

import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ListenerAction,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";

import { Cluster, ContainerInsights, ICluster } from "aws-cdk-lib/aws-ecs";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import { VpcLink } from "aws-cdk-lib/aws-apigatewayv2";

import { DeploymentYaml, toPrincipals } from "./config/config";
import {
  CONTROL_PLANE_PORTS as cpPorts,
  DATA_PLANE_PORTS as dpPorts,
} from "./config/port-mappings";
import { EdcApi } from "./constructs/edc-api";
import { EdcSecretCleanup } from "./constructs/edc-secret-cleanup";
import { EdcTokenKeyPairProvider } from "./constructs/edc-token-key-pair";
import { PortalConnectorProvider } from "./constructs/portal-connector";
import { DtrOfferProvider } from "./constructs/dtr-offer";
import { BASYX_PORT } from "./basyx/names";

export interface SharedInfraStackProps extends StackProps {
  readonly config: DeploymentYaml;
  readonly deploymentName: string;
}

export class SharedInfraStack extends Stack {
  readonly albArn: string;
  readonly albDnsName: string;
  readonly albSecurityGroupId: string;
  readonly edcTaskSecurityGroupId: string;
  readonly controlPlaneImage: DockerImageAsset;
  readonly dataPlaneImage: DockerImageAsset;
  readonly dataPlaneUrl: string;
  readonly dspUrl: string;
  readonly managementUrl: string;
  readonly portalConnectorServiceToken: string;
  readonly dtrOfferServiceToken: string;
  readonly tokenKeyPairServiceToken: string;
  readonly ecsCluster: ICluster;
  readonly listenerArns: { [port: number]: string };
  readonly vpc: IVpc;
  readonly vpcLinkId: string;

  constructor(scope: Construct, id: string, props: SharedInfraStackProps) {
    super(scope, id, props);

    const config = props.config;

    this.vpc = new Vpc(this, "Vpc", {
      ipAddresses: IpAddresses.cidr(config.vpcIpAddresses),
      maxAzs: 2,
      natGateways: config.profile === "development" ? 1 : 2,
    });
    this.vpc.addGatewayEndpoint("S3Endpoint", {
      service: GatewayVpcEndpointAwsService.S3,
    });
    this.vpc.addGatewayEndpoint("DynamoDbEndpoint", {
      service: GatewayVpcEndpointAwsService.DYNAMODB,
    });

    this.ecsCluster = new Cluster(this, "EcsCluster", {
      containerInsightsV2: config.containerInsights
        ? ContainerInsights.ENABLED
        : ContainerInsights.DISABLED,
      vpc: this.vpc,
    });

    // ignoreMode DOCKER applies the .dockerignore to the asset hash (not just the
    // build), so the hash stays stable when the jar is unchanged.
    this.controlPlaneImage = new DockerImageAsset(this, "ControlPlaneImage", {
      directory: resolve(__dirname, "../../edc/control-plane"),
      platform: Platform.LINUX_ARM64,
      ignoreMode: IgnoreMode.DOCKER,
    });
    this.dataPlaneImage = new DockerImageAsset(this, "DataPlaneImage", {
      directory: resolve(__dirname, "../../edc/data-plane"),
      platform: Platform.LINUX_ARM64,
      ignoreMode: IgnoreMode.DOCKER,
    });

    const albSg = new SecurityGroup(this, "AlbSecurityGroup", {
      description: "Security group for ALB communication with EDC services",
      allowAllOutbound: false,
      vpc: this.vpc,
    });

    const allPorts = [...Object.values(cpPorts), ...Object.values(dpPorts)];
    // Data planes read BaSyx through its own listener, so the management port
    // stays reachable from the VPC link only. It exists in every deployment so
    // that removing a basyx entry never removes an export a BaSyx stack imports.
    const listenerPorts = [...allPorts, BASYX_PORT];
    new Set(listenerPorts).forEach((port) =>
      albSg.addEgressRule(Peer.ipv4(this.vpc.vpcCidrBlock), Port.tcp(port)),
    );

    // The VPC link shares the ALB security group (replacing a VPC link's
    // security group replaces the link), so API Gateway traffic is allowed by
    // a self-reference. Connector tasks reach the ALB only on the control ports
    // and the BaSyx read port; a BaSyx read also needs that BPNL's Cognito token,
    // whose secret only its dtrConnector's data plane can read.
    const edcTaskSg = new SecurityGroup(this, "EdcTaskSecurityGroup", {
      description:
        "Attached to EDC tasks so they can call the ALB control ports",
      allowAllOutbound: false,
      vpc: this.vpc,
    });
    for (const port of [
      cpPorts.default,
      cpPorts.management,
      cpPorts.protocol,
      dpPorts.default,
      dpPorts.public,
    ]) {
      albSg.addIngressRule(albSg, Port.tcp(port), "API Gateway VPC link");
    }
    for (const port of [cpPorts.control, dpPorts.control, BASYX_PORT]) {
      albSg.addIngressRule(edcTaskSg, Port.tcp(port), "EDC tasks");
    }

    const alb = new ApplicationLoadBalancer(this, "Alb", {
      internetFacing: false,
      securityGroup: albSg,
      vpc: this.vpc,
    });

    this.listenerArns = {};
    for (const port of new Set(listenerPorts)) {
      const listener = alb.addListener(`Listener${port}`, {
        port,
        open: false,
        protocol: ApplicationProtocol.HTTP,
        defaultAction: ListenerAction.fixedResponse(404, {
          messageBody:
            port === BASYX_PORT
              ? "No matching BaSyx service"
              : "No matching EDC connector",
        }),
      });
      this.listenerArns[port] = listener.listenerArn;
    }

    this.albArn = alb.loadBalancerArn;
    this.albDnsName = alb.loadBalancerDnsName;
    this.albSecurityGroupId = albSg.securityGroupId;
    this.edcTaskSecurityGroupId = edcTaskSg.securityGroupId;

    const vpcLink = new VpcLink(this, "VpcLink", {
      vpc: this.vpc,
      subnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [albSg],
    });
    this.vpcLinkId = vpcLink.vpcLinkId;

    const api = new EdcApi(this, "EdcApi", {
      albArn: this.albArn,
      loadBalancerAddress: this.albDnsName,
      vpcLinkId: this.vpcLinkId,
      domain: config.domainName
        ? {
            certificate: Certificate.fromCertificateArn(
              this,
              "Certificate",
              config.certificateArn!,
            ),
            hostedZone: HostedZone.fromHostedZoneAttributes(
              this,
              "HostedZone",
              {
                hostedZoneId: config.hostedZoneId!,
                zoneName: config.domainName,
              },
            ),
          }
        : undefined,
      managementApiPrincipals: toPrincipals(config.managementApiPrincipals),
      observabilityApiPrincipals: toPrincipals(
        config.observabilityApiPrincipals,
      ),
      profile: config.profile,
      dataTrace: config.logLevel === "DEBUG" || config.logLevel === "TRACE",
    });
    this.dspUrl = api.dspUrl;
    this.dataPlaneUrl = api.dataPlaneUrl;
    this.managementUrl = api.managementUrl;

    new EdcSecretCleanup(this, "EdcSecretCleanup");

    this.portalConnectorServiceToken = new PortalConnectorProvider(
      this,
      "PortalConnectorProvider",
      props.deploymentName,
    ).serviceToken;
    this.tokenKeyPairServiceToken = new EdcTokenKeyPairProvider(
      this,
      "EdcTokenKeyPairProvider",
      props.deploymentName,
    ).serviceToken;
    this.dtrOfferServiceToken = new DtrOfferProvider(this, "DtrOfferProvider", {
      vpc: this.vpc,
      albSecurityGroup: albSg,
    }).serviceToken;

    new CfnOutput(this, "VpcId", { value: this.vpc.vpcId });
    new CfnOutput(this, "ClusterArn", { value: this.ecsCluster.clusterArn });
    new CfnOutput(this, "AlbDnsName", { value: this.albDnsName });
    new CfnOutput(this, "DspApiUrl", { value: this.dspUrl });
    new CfnOutput(this, "ManagementApiUrl", { value: this.managementUrl });
  }
}
