// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HealthCheck,
  NetworkLoadBalancer,
  NetworkTargetGroup,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";

import { Construct } from "constructs";
import { IVpc, Peer, Port, SecurityGroup } from "aws-cdk-lib/aws-ec2";
import { VpcLink } from "aws-cdk-lib/aws-apigateway";

export interface EdcNlbProps {
  readonly controlPlaneHealthCheck: HealthCheck;
  readonly controlPlanePorts: Set<number>;
  readonly dataPlaneHealthCheck: HealthCheck;
  readonly dataPlanePorts: Set<number>;
  readonly vpc: IVpc;
}

export interface EdcNlbOutputs {
  readonly controlPlaneTargetGroups: Map<number, NetworkTargetGroup>;
  readonly dataPlaneTargetGroups: Map<number, NetworkTargetGroup>;
  readonly dnsName: string;
  readonly securityGroupId: string;
  readonly vpcLinkId: string;
}

export class EdcNlb extends NetworkLoadBalancer {
  readonly outputs: EdcNlbOutputs;

  constructor(scope: Construct, id: string, props: EdcNlbProps) {
    super(scope, id, {
      crossZoneEnabled: true,
      // https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-nlb-for-vpclink-using-console.html
      enforceSecurityGroupInboundRulesOnPrivateLinkTraffic: false,
      internetFacing: false,
      vpc: props.vpc,
    });

    const nlbSecurityGroup = new SecurityGroup(this, "NlbSecurityGroup", {
      description: "Security group for NLB communication with EDC services",
      allowAllOutbound: false,
      vpc: props.vpc,
    });

    new Set([...props.controlPlanePorts, ...props.dataPlanePorts]).forEach(
      (port) =>
        nlbSecurityGroup.addEgressRule(
          Peer.ipv4(props.vpc.vpcCidrBlock),
          Port.tcp(port),
        ),
    );

    // Allow data plane to register at control plane control API
    nlbSecurityGroup.addIngressRule(
      Peer.ipv4(props.vpc.vpcCidrBlock),
      Port.tcp(8083),
    );
    this.addSecurityGroup(nlbSecurityGroup);

    const vpcLink = new VpcLink(this, "VpcLink", { targets: [this] });

    const controlPlaneTargetGroups = this.createTargetGroups(
      "Ctrl",
      props.controlPlanePorts,
      props.controlPlaneHealthCheck,
    );
    const dataPlaneTargetGroups = this.createTargetGroups(
      "Data",
      props.dataPlanePorts,
      props.dataPlaneHealthCheck,
    );

    this.outputs = {
      controlPlaneTargetGroups: controlPlaneTargetGroups,
      dataPlaneTargetGroups: dataPlaneTargetGroups,
      dnsName: this.loadBalancerDnsName,
      securityGroupId: nlbSecurityGroup.securityGroupId,
      vpcLinkId: vpcLink.vpcLinkId,
    };
  }

  private createTargetGroups(
    prefix: string,
    ports: Set<number>,
    healthCheck: HealthCheck,
  ): Map<number, NetworkTargetGroup> {
    const targetGroups = new Map<number, NetworkTargetGroup>();

    ports.forEach((port) => {
      const targetGroup = new NetworkTargetGroup(
        this,
        `${prefix}${port}TargetGroup`,
        {
          healthCheck: healthCheck,
          port: port,
          vpc: this.vpc,
        },
      );

      this.addListener(`${prefix}${port}Listener`, {
        defaultTargetGroups: [targetGroup],
        port: port,
      });

      targetGroups.set(port, targetGroup);
    });

    return targetGroups;
  }
}
