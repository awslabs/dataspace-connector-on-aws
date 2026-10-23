// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "path";
import { CustomResource, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  ISecurityGroup,
  IVpc,
  Port,
  SecurityGroup,
  SubnetType,
} from "aws-cdk-lib/aws-ec2";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { Provider } from "aws-cdk-lib/custom-resources";

import { CONTROL_PLANE_PORTS } from "../config/port-mappings";
import type { DtrOfferProperties } from "../dtr-offer/handler";

/**
 * Provider of the DtrOffer custom resource, once per deployment. The handler
 * runs in the VPC and reaches only the management listener of the internal
 * load balancer; it needs no AWS API access.
 */
export class DtrOfferProvider extends Construct {
  readonly serviceToken: string;

  constructor(
    scope: Construct,
    id: string,
    props: { vpc: IVpc; albSecurityGroup: ISecurityGroup },
  ) {
    super(scope, id);

    const port = Port.tcp(CONTROL_PLANE_PORTS.management);
    const securityGroup = new SecurityGroup(this, "SecurityGroup", {
      allowAllOutbound: false,
      description: "DtrOffer handler, calls the management listener",
      vpc: props.vpc,
    });
    securityGroup.addEgressRule(props.albSecurityGroup, port);
    props.albSecurityGroup.addIngressRule(
      securityGroup,
      port,
      "DtrOffer handler",
    );

    const onEvent = new Function(this, "OnEvent", {
      runtime: Runtime.NODEJS_24_X,
      handler: "handler.onEvent",
      timeout: Duration.minutes(1),
      code: Code.fromAsset(resolve(__dirname, "../dtr-offer"), {
        exclude: ["*.d.ts", "*.map"],
      }),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [securityGroup],
    });
    this.serviceToken = new Provider(this, "Provider", {
      onEventHandler: onEvent,
    }).serviceToken;
  }
}

/** The DTR offer of a BaSyx deployment on its dtrConnector. */
export class DtrOffer extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: { serviceToken: string; properties: DtrOfferProperties },
  ) {
    super(scope, id);
    new CustomResource(this, "Resource", {
      serviceToken: props.serviceToken,
      resourceType: "Custom::DtrOffer",
      properties: { ...props.properties },
    });
  }
}
