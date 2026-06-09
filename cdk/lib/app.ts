// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App, Tags } from "aws-cdk-lib";

import { SharedInfraStack } from "./shared-infra-stack";
import { ConnectorStack } from "./connector-stack";

import {
  connectorPriority,
  DEPLOYMENT_CONFIG,
  validateConnectorId,
} from "./config/environments";

const app = new App();

const sharedInfra = new SharedInfraStack(
  app,
  "DataspaceConnectorSharedInfraStack",
  {
    config: DEPLOYMENT_CONFIG.sharedInfra,
  },
);

// Detect priority collisions at synth time
const priorities = new Map<number, string>();

DEPLOYMENT_CONFIG.connectors.forEach((connectorConfig) => {
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
    app,
    `DataspaceConnector-${connectorConfig.connectorId}`,
    {
      connectorConfig,
      sharedInfra,
      sharedInfraConfig: DEPLOYMENT_CONFIG.sharedInfra,
      priority,
    },
  );
  stack.addDependency(sharedInfra);
});

Tags.of(app).add("Project", "dataspace-connector-on-aws");
Tags.of(app).add("GitRepo", "github.com/awslabs/dataspace-connector-on-aws");
