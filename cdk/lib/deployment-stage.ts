// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Stage, StageProps, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";

import { SharedInfraStack } from "./shared-infra-stack";
import { ConnectorStack } from "./connector-stack";

import { connectorPriority, DeploymentConfig } from "./config/config";
import { ResolvedEdcIam } from "./portal/provision-output";

export interface DeploymentStageProps extends StageProps {
  readonly config: DeploymentConfig;
  readonly resolvedEdcIam: ResolvedEdcIam;
  readonly activeBpnls: string[];
}

export class DeploymentStage extends Stage {
  constructor(scope: Construct, id: string, props: DeploymentStageProps) {
    super(scope, id, props);

    const { deployment, connectors } = props.config;

    const sharedInfra = new SharedInfraStack(
      this,
      "DataspaceConnectorSharedInfraStack",
      { config: deployment, adminBpnls: props.activeBpnls },
    );

    const priorities = new Map<number, string>();

    connectors.forEach((connector) => {
      // Deploy-gate: only connectors provision resolved to IDENTITY_READY have
      // an entry in the ephemeral edcIam map. Others are skipped this run.
      const edcIam = props.resolvedEdcIam[connector.connectorId];
      if (!edcIam) return;

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
        `DataspaceConnector-${connector.connectorId}`,
        { connector, deployment, sharedInfra, priority, edcIam },
      );
      stack.addDependency(sharedInfra);
    });

    Tags.of(this).add("Project", "dataspace-connector-on-aws");
    Tags.of(this).add(
      "GitRepo",
      "github.com/awslabs/dataspace-connector-on-aws",
    );
  }
}
