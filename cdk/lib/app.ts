// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App, Tags } from "aws-cdk-lib";

import { SharedInfraStack } from "./shared-infra-stack";
import { ConnectorStack } from "./connector-stack";
import { DEPLOYMENT_CONFIG, validateConnectorId } from "./config/environments";

const app = new App();

const sharedInfra = new SharedInfraStack(
  app,
  "DataspaceConnectorSharedInfraStack",
  {
    config: DEPLOYMENT_CONFIG.sharedInfra,
  },
);

DEPLOYMENT_CONFIG.connectors.forEach((connectorConfig, index) => {
  validateConnectorId(connectorConfig.connectorId);
  const stack = new ConnectorStack(
    app,
    `DataspaceConnector-${connectorConfig.connectorId}`,
    {
      connectorConfig,
      sharedInfra,
      sharedInfraConfig: DEPLOYMENT_CONFIG.sharedInfra,
      priority: index + 1,
    },
  );
  stack.addDependency(sharedInfra);
});

Tags.of(app).add("Project", "dataspace-connector-on-aws");
Tags.of(app).add("GitRepo", "github.com/awslabs/dataspace-connector-on-aws");
