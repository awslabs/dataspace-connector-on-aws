// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";

import { Construct } from "constructs";
import { IPrincipal } from "aws-cdk-lib/aws-iam";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { HostedZone } from "aws-cdk-lib/aws-route53";

import {
  ControlPlanePortMapping,
  DataPlanePortMapping,
} from "./config/port-mappings";

import { InfraConstructs } from "./constructs/infra-constructs";
import { ServiceConstructs } from "./constructs/service-constructs";

export interface DataspaceConnectorStackProps extends StackProps {
  readonly certificateArn?: string;
  readonly controlPlaneCpu: number;
  readonly controlPlaneMemoryLimitMiB: number;
  readonly controlPlanePolicyMonitorIteration: string;
  readonly controlPlanePortMapping: ControlPlanePortMapping;
  readonly dataPlaneCpu: number;
  readonly dataPlaneMemoryLimitMiB: number;
  readonly dataPlanePortMapping: DataPlanePortMapping;
  readonly domainName?: string;
  readonly edcIam: { [key: string]: string };
  readonly edcStateRemovalPolicy: RemovalPolicy;
  readonly hostedZoneId?: string;
  readonly managementApiAuthKey: string;
  readonly managementApiPrincipals: IPrincipal[];
  readonly observabilityApiPrincipals: IPrincipal[];
  readonly vpcIpAddresses: string;
}

export class DataspaceConnectorStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: DataspaceConnectorStackProps,
  ) {
    super(scope, id, props);

    // Look up custom domain resources if configured

    let certificate;
    let hostedZone;

    if (props.domainName && props.hostedZoneId && props.certificateArn) {
      certificate = Certificate.fromCertificateArn(
        this,
        "Certificate",
        props.certificateArn,
      );
      hostedZone = HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.domainName,
      });
    } else if (props.domainName || props.hostedZoneId || props.certificateArn) {
      throw new Error(
        "Custom domain requires all three: domainName, hostedZoneId, and certificateArn",
      );
    }

    const infraConstructs = new InfraConstructs(this, "Infra", {
      certificate: certificate,
      controlPlanePortMapping: props.controlPlanePortMapping,
      dataPlanePortMapping: props.dataPlanePortMapping,
      edcStateRemovalPolicy: props.edcStateRemovalPolicy,
      hostedZone: hostedZone,
      managementApiPrincipals: props.managementApiPrincipals,
      observabilityApiPrincipals: props.observabilityApiPrincipals,
      vpcIpAddresses: props.vpcIpAddresses,
    });

    new ServiceConstructs(this, "Service", {
      apiAuthKey: props.managementApiAuthKey,
      controlPlaneCpu: props.controlPlaneCpu,
      controlPlaneMemoryLimitMiB: props.controlPlaneMemoryLimitMiB,
      controlPlanePolicyMonitorIteration:
        props.controlPlanePolicyMonitorIteration,
      controlPlanePortMapping: props.controlPlanePortMapping,
      dataPlaneCpu: props.dataPlaneCpu,
      dataPlaneMemoryLimitMiB: props.dataPlaneMemoryLimitMiB,
      dataPlanePortMapping: props.dataPlanePortMapping,
      ddbTables: infraConstructs.ddbTables,
      edcIamEnvVars: props.edcIam,
      infraConstructs: infraConstructs,
    });
  }
}
