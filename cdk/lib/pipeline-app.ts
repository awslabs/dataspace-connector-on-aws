// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { App } from "aws-cdk-lib";

import * as yaml from "js-yaml";

import { PipelineStack } from "./pipeline-stack";
import { loadConfigFromYaml } from "./config/config-loader";
import { PipelineYaml } from "./config/schemas";

const app = new App();

// Resolve config path from context or default relative location
const configPath = app.node.tryGetContext("config-path")
  ? resolve(app.node.tryGetContext("config-path"))
  : resolve(__dirname, "../../config");

// Load pipeline.yaml
const pipelineYamlPath = resolve(configPath, "pipeline.yaml");
if (!existsSync(pipelineYamlPath)) {
  throw new Error(
    `pipeline.yaml not found at ${pipelineYamlPath}. ` +
      `Provide --context config-path=<path> or place config files in ./config/`,
  );
}
const pipelineConfig = yaml.load(
  readFileSync(pipelineYamlPath, "utf-8"),
) as PipelineYaml;

// Load deployment config from YAML
const deploymentConfig = loadConfigFromYaml(configPath);
if (!deploymentConfig) {
  throw new Error(
    `deployment.yaml not found in ${configPath}. ` +
      `The config directory must contain deployment.yaml and connectors/*.yaml files.`,
  );
}

new PipelineStack(app, "DataspaceConnectorPipelineStack", {
  pipelineConfig,
  deploymentConfig,
});
