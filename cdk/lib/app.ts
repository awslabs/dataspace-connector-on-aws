// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "path";
import { App, Tags } from "aws-cdk-lib";

import { SharedInfraStack } from "./shared-infra-stack";
import { ConnectorStack } from "./connector-stack";
import { loadConfigFromYaml } from "./config/config-loader";

import {
  connectorPriority,
  DeploymentConfig,
  DEPLOYMENT_CONFIG,
  validateConnectorId,
} from "./config/environments";

const app = new App();

// Config resolution: YAML (from context or ./config/) > environments.ts
const configPath = app.node.tryGetContext("config-path")
  ? resolve(app.node.tryGetContext("config-path"))
  : resolve(__dirname, "../config");

const config: DeploymentConfig =
  loadConfigFromYaml(configPath) ?? DEPLOYMENT_CONFIG;

const sharedInfra = new SharedInfraStack(
  app,
  "DataspaceConnectorSharedInfraStack",
  { config: config.sharedInfra },
);

// Detect priority collisions at synth time
const priorities = new Map<number, string>();

config.connectors.forEach((connectorConfig) => {
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
      sharedInfraConfig: config.sharedInfra,
      priority,
    },
  );
  stack.addDependency(sharedInfra);
});

Tags.of(app).add("Project", "dataspace-connector-on-aws");
Tags.of(app).add("GitRepo", "github.com/awslabs/dataspace-connector-on-aws");
