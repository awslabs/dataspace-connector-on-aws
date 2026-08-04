// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { App, Tags } from "aws-cdk-lib";

import * as yaml from "js-yaml";

import { PipelineStack } from "./pipeline-stack";
import { loadDeploymentConfig, PipelineYaml } from "./config/config";
import { readActiveBpnls, readResolvedEdcIam } from "./portal/provision-output";

const app = new App();

// Config path from context, defaulting to the bundled templates (used for a
// bare `cdk synth` sanity check). Real deployments pass --context config-path.
const configPath = app.node.tryGetContext("config-path")
  ? resolve(app.node.tryGetContext("config-path"))
  : resolve(__dirname, "../config-templates");

const pipelineYamlPath = resolve(configPath, "pipeline.yaml");
if (!existsSync(pipelineYamlPath)) {
  throw new Error(
    `pipeline.yaml not found at ${pipelineYamlPath}. ` +
      `Provide --context config-path=<path>.`,
  );
}

const pipelineConfig = yaml.load(
  readFileSync(pipelineYamlPath, "utf-8"),
) as PipelineYaml;

const deploymentConfig = loadDeploymentConfig(configPath);
const resolvedEdcIam = readResolvedEdcIam(configPath);
const activeBpnls = readActiveBpnls(configPath);

new PipelineStack(app, "DataspaceConnectorPipelineStack", {
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
