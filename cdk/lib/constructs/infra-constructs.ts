// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "path";

import { Construct } from "constructs";
import { IPrincipal } from "aws-cdk-lib/aws-iam";
import { CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import {
  GatewayVpcEndpointAwsService,
  IpAddresses,
  IVpc,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { Cluster, ContainerInsights, ICluster } from "aws-cdk-lib/aws-ecs";
import { Protocol } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Bucket, IBucket } from "aws-cdk-lib/aws-s3";
import { TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { IHostedZone } from "aws-cdk-lib/aws-route53";

import {
  ControlPlanePortMapping,
  DataPlanePortMapping,
} from "../config/port-mappings";

import { EDC_SECRETS_MANAGER_ALIASES } from "../config/environments";

import { EdcApi } from "./edc-api";
import { EdcDdb } from "./edc-ddb";
import { EdcNlb, EdcNlbOutputs } from "./edc-nlb";
import { EdcTokenKeyPair } from "./edc-token-key-pair";

import { DeploymentProfile, Architecture } from "../config/environments";

export interface InfraConstructsProps {
  readonly architecture?: Architecture;
  readonly certificate?: ICertificate;
  readonly controlPlanePortMapping: ControlPlanePortMapping;
  readonly dataPlanePortMapping: DataPlanePortMapping;
  readonly edcStateRemovalPolicy: RemovalPolicy;
  readonly hostedZone?: IHostedZone;
  readonly managementApiPrincipals: IPrincipal[];
  readonly observabilityApiPrincipals: IPrincipal[];
  readonly profile: DeploymentProfile;
  readonly vpcIpAddresses: string;
}

export class InfraConstructs extends Construct {
  readonly api: EdcApi;
  readonly controlPlaneImage: DockerImageAsset;
  readonly dataPlaneImage: DockerImageAsset;
  readonly ddbTables: TableV2[];
  readonly ecsCluster: ICluster;
  readonly nlbOutputs: EdcNlbOutputs;
  readonly s3Bucket: IBucket;
  readonly vpc: IVpc;

  constructor(scope: Construct, id: string, props: InfraConstructsProps) {
    super(scope, id);

    // Build and push EDC container images

    const imagePlatform =
      props.architecture === "arm64"
        ? Platform.LINUX_ARM64
        : Platform.LINUX_AMD64;

    const controlPlaneDir = resolve(__dirname, "../../../edc/control-plane");
    this.controlPlaneImage = new DockerImageAsset(scope, "ControlPlaneImage", {
      directory: controlPlaneDir,
      platform: imagePlatform,
    });

    const dataPlaneDir = resolve(__dirname, "../../../edc/data-plane");
    this.dataPlaneImage = new DockerImageAsset(scope, "DataPlaneImage", {
      directory: dataPlaneDir,
      platform: imagePlatform,
    });

    // Create DynamoDB tables for EDC

    const ddb = new EdcDdb(scope, "EdcDdb", {
      encryptionKey: undefined,
      removalPolicy: props.edcStateRemovalPolicy,
    });
    this.ddbTables = ddb.tables;

    // Create S3 bucket for data plane

    this.s3Bucket = new Bucket(scope, "DataPlaneBucket", {
      enforceSSL: true,
      removalPolicy: props.edcStateRemovalPolicy,
    });

    // Create VPC, ECS cluster and NLB

    this.vpc = new Vpc(scope, "Vpc", {
      ipAddresses: IpAddresses.cidr(props.vpcIpAddresses),
      maxAzs: props.profile === "development" ? 1 : 2,
    });

    this.vpc.addGatewayEndpoint("S3Endpoint", {
      service: GatewayVpcEndpointAwsService.S3,
    });

    this.vpc.addGatewayEndpoint("DynamoDbEndpoint", {
      service: GatewayVpcEndpointAwsService.DYNAMODB,
    });

    this.ecsCluster = new Cluster(scope, "EcsCluster", {
      containerInsightsV2:
        props.profile === "production"
          ? ContainerInsights.ENABLED
          : ContainerInsights.DISABLED,
      vpc: this.vpc,
    });

    const nlb = new EdcNlb(scope, "EdcNlb", {
      controlPlaneHealthCheck: {
        healthyThresholdCount: 3,
        interval: Duration.seconds(10),
        path: "/api/check/health",
        port: `${props.controlPlanePortMapping.default}`,
        protocol: Protocol.HTTP,
        timeout: Duration.seconds(5),
        unhealthyThresholdCount: 5,
      },
      controlPlanePorts: new Set<number>(
        Object.values(props.controlPlanePortMapping),
      ),
      dataPlaneHealthCheck: {
        healthyThresholdCount: 3,
        interval: Duration.seconds(10),
        path: "/api/check/health",
        port: `${props.dataPlanePortMapping.default}`,
        protocol: Protocol.HTTP,
        timeout: Duration.seconds(5),
        unhealthyThresholdCount: 5,
      },
      dataPlanePorts: new Set<number>(
        Object.values(props.dataPlanePortMapping),
      ),
      vpc: this.vpc,
    });
    this.nlbOutputs = nlb.outputs;

    // Create public-facing EDC APIs

    this.api = new EdcApi(scope, "EdcApi", {
      certificate: props.certificate,
      controlPlanePortMapping: props.controlPlanePortMapping,
      dataPlanePortMapping: props.dataPlanePortMapping,
      hostedZone: props.hostedZone,
      loadBalancerAddress: nlb.loadBalancerDnsName,
      managementApiPrincipals: props.managementApiPrincipals,
      observabilityApiPrincipals: props.observabilityApiPrincipals,
      profile: props.profile,
      vpcLinkId: this.nlbOutputs.vpcLinkId,
    });

    // Create empty EDC OAuth client secret

    const oauthClientSecret = new Secret(scope, "EdcOauthClientSecret", {
      secretName: EDC_SECRETS_MANAGER_ALIASES.DCP_STS_OAUTH_CLIENT_SECRET_ALIAS,
      description: "EDC OAuth client secret from Cofinity-X Portal",
    });

    // Generate EC key pair for data plane EDR token signing

    new EdcTokenKeyPair(scope, "EdcTokenKeyPair", {
      privateKeySecretName:
        EDC_SECRETS_MANAGER_ALIASES.TOKEN_SIGNER_PRIVATE_KEY,
      publicKeySecretName:
        EDC_SECRETS_MANAGER_ALIASES.TOKEN_VERIFIER_PUBLIC_KEY,
    });

    new CfnOutput(scope, "EdcOauthClientSecretArn", {
      value: oauthClientSecret.secretArn,
      description:
        "Populate with the OAuth client secret of your EDC's technical user",
    });

    new CfnOutput(scope, "EdcDataPlaneBucketName", {
      value: this.s3Bucket.bucketName,
      description: "S3 bucket for data plane asset storage",
    });
  }
}
