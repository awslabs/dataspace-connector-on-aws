// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Stage, StageProps, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";

import { SharedInfraStack } from "./shared-infra-stack";
import { ConnectorStack } from "./connector-stack";

import {
  connectorPriority,
  DeploymentConfig,
  validateConnectorId,
} from "./config/environments";

export interface DeploymentStageProps extends StageProps {
  readonly config: DeploymentConfig;
}

export class DeploymentStage extends Stage {
  constructor(scope: Construct, id: string, props: DeploymentStageProps) {
    super(scope, id, props);

    const sharedInfra = new SharedInfraStack(
      this,
      "DataspaceConnectorSharedInfraStack",
      { config: props.config.sharedInfra },
    );

    const priorities = new Map<number, string>();

    props.config.connectors.forEach((connectorConfig) => {
      validateConnectorId(connectorConfig.connectorId);
      const priority = connectorPriority(connectorConfig.connectorId);
      const existing = priorities.get(priority);
      if (existing) {
        throw new Error(
          `Priority collision: connectors "${existing}" and "${connectorConfig.connectorId}" both hash to priority ${priority}. Rename one connector to resolve.`,
        );
      }
      priorities.set(priority, connectorConfig.connectorId);

      const stack = new ConnectorStack(
        this,
        `DataspaceConnector-${connectorConfig.connectorId}`,
        {
          connectorConfig,
          sharedInfra,
          sharedInfraConfig: props.config.sharedInfra,
          priority,
        },
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
