// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "path";

import { Construct } from "constructs";
import { IPrincipal } from "aws-cdk-lib/aws-iam";
import { CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import { IpAddresses, IVpc, Vpc } from "aws-cdk-lib/aws-ec2";
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

import { EDC_IAM_ENVIRONMENT_VARIABLE_KEYS } from "../config/environments";

import { EdcApi } from "./edc-api";
import { EdcDdb } from "./edc-ddb";
import { EdcNlb, EdcNlbOutputs } from "./edc-nlb";

export interface InfraConstructsProps {
  readonly certificate?: ICertificate;
  readonly controlPlanePortMapping: ControlPlanePortMapping;
  readonly dataPlanePortMapping: DataPlanePortMapping;
  readonly edcStateRemovalPolicy: RemovalPolicy;
  readonly hostedZone?: IHostedZone;
  readonly managementApiPrincipals: IPrincipal[];
  readonly observabilityApiPrincipals: IPrincipal[];
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

    const controlPlaneDir = resolve(__dirname, "../../../edc/control-plane");
    this.controlPlaneImage = new DockerImageAsset(scope, "ControlPlaneImage", {
      directory: controlPlaneDir,
      platform: Platform.LINUX_AMD64,
    });

    const dataPlaneDir = resolve(__dirname, "../../../edc/data-plane");
    this.dataPlaneImage = new DockerImageAsset(scope, "DataPlaneImage", {
      directory: dataPlaneDir,
      platform: Platform.LINUX_AMD64,
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
    });

    this.ecsCluster = new Cluster(scope, "EcsCluster", {
      containerInsightsV2: ContainerInsights.ENABLED,
      vpc: this.vpc,
    });

    const nlb = new EdcNlb(scope, "EdcNlb", {
      controlPlaneHealthCheck: {
        healthyThresholdCount: 3,
        interval: Duration.seconds(5),
        path: "/api/check/health",
        port: `${props.controlPlanePortMapping.default}`,
        protocol: Protocol.HTTP,
        timeout: Duration.seconds(2),
        unhealthyThresholdCount: 2,
      },
      controlPlanePorts: new Set<number>(
        Object.values(props.controlPlanePortMapping),
      ),
      dataPlaneHealthCheck: {
        healthyThresholdCount: 3,
        interval: Duration.seconds(5),
        path: "/api/check/health",
        port: `${props.dataPlanePortMapping.default}`,
        protocol: Protocol.HTTP,
        timeout: Duration.seconds(2),
        unhealthyThresholdCount: 2,
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
      vpcLinkId: this.nlbOutputs.vpcLinkId,
    });

    // Create empty EDC OAuth client secret

    const oauthClientSecret = new Secret(scope, "EdcOauthClientSecret", {
      secretName: EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.OAUTH_CLIENT_SECRET,
      description: "EDC OAuth client secret from Cofinity-X Portal",
    });

    new CfnOutput(scope, "EdcOauthClientSecretArn", {
      value: oauthClientSecret.secretArn,
      description:
        "Populate with the OAuth client secret of your EDC's technical user",
    });
  }
}
