// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";

import { Construct } from "constructs";
import { IPrincipal } from "aws-cdk-lib/aws-iam";

import {
  ControlPlanePortMapping,
  DataPlanePortMapping,
} from "./config/port-mappings";

import { InfraConstructs } from "./constructs/infra-constructs";
import { ServiceConstructs } from "./constructs/service-constructs";

export interface DataspaceConnectorStackProps extends StackProps {
  readonly controlPlaneCpu: number;
  readonly controlPlaneMemoryLimitMiB: number;
  readonly controlPlanePolicyMonitorIteration: string;
  readonly controlPlanePortMapping: ControlPlanePortMapping;
  readonly dataPlaneCpu: number;
  readonly dataPlaneMemoryLimitMiB: number;
  readonly dataPlanePortMapping: DataPlanePortMapping;
  readonly edcIam: { [key: string]: string };
  readonly edcStateRemovalPolicy: RemovalPolicy;
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

    const infraConstructs = new InfraConstructs(this, "Infra", {
      controlPlanePortMapping: props.controlPlanePortMapping,
      dataPlanePortMapping: props.dataPlanePortMapping,
      edcStateRemovalPolicy: props.edcStateRemovalPolicy,
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
