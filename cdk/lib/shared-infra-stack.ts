// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "path";
import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
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

import { SharedInfraConfig } from "./config/environments";
import { EdcApi } from "./constructs/edc-api";
import { EdcSecretCleanup } from "./constructs/edc-secret-cleanup";

export interface SharedInfraStackProps extends StackProps {
  readonly config: SharedInfraConfig;
}

export class SharedInfraStack extends Stack {
  readonly albArn: string;
  readonly albDnsName: string;
  readonly albSecurityGroupId: string;
  readonly controlPlaneImage: DockerImageAsset;
  readonly dataPlaneImage: DockerImageAsset;
  readonly dataPlaneUrl: string;
  readonly dspUrl: string;
  readonly ecsCluster: ICluster;
  readonly listenerArns: { [port: number]: string };
  readonly vpc: IVpc;
  readonly vpcLinkId: string;

  constructor(scope: Construct, id: string, props: SharedInfraStackProps) {
    super(scope, id, props);

    const config = props.config;

    // VPC — ALB requires minimum 2 AZs; use single NAT in dev to save cost
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

    // ECS Cluster
    this.ecsCluster = new Cluster(this, "EcsCluster", {
      containerInsightsV2: config.containerInsights
        ? ContainerInsights.ENABLED
        : ContainerInsights.DISABLED,
      vpc: this.vpc,
    });

    // Container images
    this.controlPlaneImage = new DockerImageAsset(this, "ControlPlaneImage", {
      directory: resolve(__dirname, "../../edc/control-plane"),
      platform: Platform.LINUX_ARM64,
    });
    this.dataPlaneImage = new DockerImageAsset(this, "DataPlaneImage", {
      directory: resolve(__dirname, "../../edc/data-plane"),
      platform: Platform.LINUX_ARM64,
    });

    // ALB
    const albSg = new SecurityGroup(this, "AlbSecurityGroup", {
      description: "Security group for ALB communication with EDC services",
      allowAllOutbound: false,
      vpc: this.vpc,
    });

    // Allow egress to all EDC ports
    const allPorts = [
      ...Object.values(config.controlPlanePortMapping),
      ...Object.values(config.dataPlanePortMapping),
    ];
    new Set(allPorts).forEach((port) =>
      albSg.addEgressRule(Peer.ipv4(this.vpc.vpcCidrBlock), Port.tcp(port)),
    );

    const alb = new ApplicationLoadBalancer(this, "Alb", {
      internetFacing: false,
      securityGroup: albSg,
      vpc: this.vpc,
    });

    // One listener per EDC port (7 total: 4 CP + 3 DP)
    this.listenerArns = {};
    for (const port of new Set(allPorts)) {
      const listener = alb.addListener(`Listener${port}`, {
        port,
        protocol: ApplicationProtocol.HTTP,
        defaultAction: ListenerAction.fixedResponse(404, {
          messageBody: "No matching EDC connector",
        }),
      });
      this.listenerArns[port] = listener.listenerArn;
    }

    this.albArn = alb.loadBalancerArn;
    this.albDnsName = alb.loadBalancerDnsName;
    this.albSecurityGroupId = albSg.securityGroupId;

    // VPC Link V2
    const vpcLink = new VpcLink(this, "VpcLink", {
      vpc: this.vpc,
      subnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [albSg],
    });
    this.vpcLinkId = vpcLink.vpcLinkId;

    // Custom domain (optional)
    let certificate;
    let hostedZone;
    if (config.domainName && config.hostedZoneId && config.certificateArn) {
      certificate = Certificate.fromCertificateArn(
        this,
        "Certificate",
        config.certificateArn,
      );
      hostedZone = HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.domainName,
      });
    }

    // REST APIs (shared across all connectors — spec uses {connectorId} path param)
    const api = new EdcApi(this, "EdcApi", {
      albArn: this.albArn,
      certificate,
      controlPlanePortMapping: config.controlPlanePortMapping,
      dataPlanePortMapping: config.dataPlanePortMapping,
      hostedZone,
      loadBalancerAddress: this.albDnsName,
      managementApiPrincipals: config.managementApiPrincipals,
      observabilityApiPrincipals: config.observabilityApiPrincipals,
      profile: config.profile,
      vpcLinkId: this.vpcLinkId,
    });

    this.dspUrl = api.outputs.dspUrl;
    this.dataPlaneUrl = api.outputs.dataPlaneUrl;

    // Scheduled cleanup of expired EDR secrets
    new EdcSecretCleanup(this, "EdcSecretCleanup");

    // Outputs for cross-stack references
    new CfnOutput(this, "VpcId", { value: this.vpc.vpcId });
    new CfnOutput(this, "ClusterArn", { value: this.ecsCluster.clusterArn });
    new CfnOutput(this, "AlbDnsName", { value: this.albDnsName });
  }
}
