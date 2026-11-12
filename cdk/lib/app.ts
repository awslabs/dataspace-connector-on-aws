// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "path";
import { App, Tags } from "aws-cdk-lib";

import { PipelineStack } from "./pipeline-stack";
import {
  assertDeploymentName,
  loadDeploymentConfig,
  loadPipelineConfig,
  resolveDeploymentName,
  validateDeploymentName,
} from "./config/config";

const app = new App();

// Config path from context, defaulting to the bundled templates (used for a
// bare `cdk synth` sanity check). Real deployments pass --context config-path.
const templates = resolve(__dirname, "../config-templates");
const configPath = app.node.tryGetContext("config-path")
  ? resolve(app.node.tryGetContext("config-path"))
  : templates;
// deploy.sh seeds a new CodeCommit config repo from the config it deploys.
const seedPath = app.node.tryGetContext("seed-path")
  ? resolve(app.node.tryGetContext("seed-path"))
  : templates;

const pipelineConfig = loadPipelineConfig(configPath);
const deploymentConfig = loadDeploymentConfig(configPath);

const deploymentName = resolveDeploymentName(pipelineConfig);
validateDeploymentName(deploymentName);
assertDeploymentName(deploymentName, app.node.tryGetContext("deployment-name"));

new PipelineStack(app, `${deploymentName}PipelineStack`, {
  pipelineConfig,
  deploymentConfig,
  seedPath,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

Tags.of(app).add("Project", "dataspace-connector-on-aws");
Tags.of(app).add("GitRepo", "github.com/awslabs/dataspace-connector-on-aws");
