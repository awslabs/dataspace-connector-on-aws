// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Stage, StageProps, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";

import { SharedInfraStack } from "./shared-infra-stack";
import { ConnectorStack } from "./connector-stack";
import { BasyxStack } from "./basyx/basyx-stack";
import { BASYX_PORT, basyxPriority } from "./basyx/names";
import { CONTROL_PLANE_PORTS } from "./config/port-mappings";

import {
  connectorPriority,
  DeploymentConfig,
  basyxEntries,
} from "./config/config";

export interface DeploymentStageProps extends StageProps {
  readonly config: DeploymentConfig;
  readonly deploymentName: string;
}

export class DeploymentStage extends Stage {
  constructor(scope: Construct, id: string, props: DeploymentStageProps) {
    super(scope, id, props);

    const { deployment, connectors } = props.config;

    const sharedInfra = new SharedInfraStack(this, "SharedInfra", {
      config: deployment,
      deploymentName: props.deploymentName,
    });

    const priorities = new Map<number, string>();
    const connectorStacks = new Map<string, ConnectorStack>();

    connectors.forEach((connector) => {
      const priority = connectorPriority(connector.connectorId);
      const existing = priorities.get(priority);
      if (existing) {
        throw new Error(
          `Priority collision: connectors "${existing}" and "${connector.connectorId}" both hash to priority ${priority}. Rename one connector to resolve.`,
        );
      }
      priorities.set(priority, connector.connectorId);

      const stack = new ConnectorStack(
        this,
        `Connector-${connector.connectorId}`,
        {
          connector,
          deployment,
          sharedInfra,
          priority,
          deploymentName: props.deploymentName,
        },
      );
      stack.addStackDependency(sharedInfra);
      connectorStacks.set(connector.connectorId, stack);
    });

    // BaSyx listener rules share the priority space with the connectors' rules.
    basyxEntries(props.config).forEach((entry) => {
      const { bpnl } = entry;
      for (const service of entry.services) {
        const priority = basyxPriority(bpnl, service);
        const existing = priorities.get(priority);
        if (existing) {
          throw new Error(
            `Priority collision: "${existing}" and basyx ${bpnl} ${service} both hash to priority ${priority}. Rename the connector to resolve.`,
          );
        }
        priorities.set(priority, `basyx ${bpnl} ${service}`);
      }
      const basyx = new BasyxStack(this, `BaSyx-${bpnl}`, {
        bpnl,
        entry,
        deploymentName: props.deploymentName,
        vpc: sharedInfra.vpc,
        cluster: sharedInfra.ecsCluster,
        alb: {
          dnsName: sharedInfra.albDnsName,
          securityGroupId: sharedInfra.albSecurityGroupId,
          managementListenerArn:
            sharedInfra.listenerArns[CONTROL_PLANE_PORTS.management],
          readListenerArn: sharedInfra.listenerArns[BASYX_PORT],
        },
        dtrOfferServiceToken: sharedInfra.dtrOfferServiceToken,
      });
      // The DTR offer is written through the dtrConnector's control plane.
      basyx.addStackDependency(connectorStacks.get(entry.dtrConnector)!);
    });

    Tags.of(this).add("Project", "dataspace-connector-on-aws");
    Tags.of(this).add(
      "GitRepo",
      "github.com/awslabs/dataspace-connector-on-aws",
    );
  }
}
