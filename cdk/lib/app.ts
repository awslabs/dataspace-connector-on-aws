// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "path";
import { App, Tags } from "aws-cdk-lib";

import { PipelineStack } from "./pipeline-stack";
import {
  loadDeploymentConfig,
  loadPipelineConfig,
  resolveDeploymentName,
  validateDeploymentName,
} from "./config/config";
import { validateCognitoDomainPrefix } from "./basyx/names";
import { readActiveBpnls, readResolvedEdcIam } from "./portal/provision-output";

const app = new App();

// Config path from context, defaulting to the bundled templates (used for a
// bare `cdk synth` sanity check). Real deployments pass --context config-path.
const configPath = app.node.tryGetContext("config-path")
  ? resolve(app.node.tryGetContext("config-path"))
  : resolve(__dirname, "../config-templates");

const pipelineConfig = loadPipelineConfig(configPath);
const deploymentConfig = loadDeploymentConfig(configPath);
const resolvedEdcIam = readResolvedEdcIam(configPath);
const activeBpnls = readActiveBpnls(configPath);

const deploymentName = resolveDeploymentName(pipelineConfig);
validateDeploymentName(deploymentName);
for (const [bpnl, entry] of Object.entries(
  deploymentConfig.deployment.basyx ?? {},
)) {
  if (entry.enabled) validateCognitoDomainPrefix(deploymentName, bpnl);
}

new PipelineStack(app, `${deploymentName}PipelineStack`, {
  pipelineConfig,
  deploymentConfig,
  resolvedEdcIam,
  activeBpnls,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

Tags.of(app).add("Project", "dataspace-connector-on-aws");
Tags.of(app).add("GitRepo", "github.com/awslabs/dataspace-connector-on-aws");
