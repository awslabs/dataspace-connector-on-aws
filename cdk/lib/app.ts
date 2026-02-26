// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App, Tags } from "aws-cdk-lib";

import { DataspaceConnectorStack } from "./dataspace-connector-stack";
import { DataspaceConnectorStackConfig } from "./config/environments";

const app = new App();

new DataspaceConnectorStack(
  app,
  "DataspaceConnectorStack",
  DataspaceConnectorStackConfig,
);

Tags.of(app).add("Project", "dataspace-connector-on-aws");
Tags.of(app).add("GitRepo", "github.com/awslabs/dataspace-connector-on-aws");
