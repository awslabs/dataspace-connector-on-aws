// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { loadDeploymentConfig, PipelineYaml } from "../lib/config/config";
import { PipelineStack } from "../lib/pipeline-stack";

const TEMPLATES = join(__dirname, "..", "config-templates");
const env = { account: "111111111111", region: "eu-central-1" };

function synth(pipeline: Partial<PipelineYaml>, seedPath = TEMPLATES) {
  const app = new App({ outdir: mkdtempSync(join(tmpdir(), "pipeline-")) });
  const stack = new PipelineStack(app, "AcmePipelineStack", {
    pipelineConfig: {
      appRepo: "awslabs/dataspace-connector-on-aws",
      appVersion: "main",
      deploymentName: "Acme",
      ...pipeline,
    },
    deploymentConfig: loadDeploymentConfig(TEMPLATES),
    seedPath,
    env,
  });
  return { template: Template.fromStack(stack), outdir: app.outdir };
}

test("CodeCommit config repo is named after the deployment and seeded from seedPath", () => {
  const seed = mkdtempSync(join(tmpdir(), "seed-"));
  cpSync(TEMPLATES, seed, { recursive: true });
  writeFileSync(join(seed, "pipeline.yaml"), "deploymentName: Acme\n");
  const { template, outdir } = synth({}, seed);

  const repos = Object.values(
    template.findResources("AWS::CodeCommit::Repository"),
  );
  expect(repos).toHaveLength(1);
  expect(repos[0].Properties.RepositoryName).toBe("Acme-config");
  const seeded = readdirSync(outdir)
    .filter((d) => d.startsWith("asset."))
    .map((d) => join(outdir, d, "pipeline.yaml"))
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, "utf-8"));
  expect(seeded).toContain("deploymentName: Acme\n");
});

test("GitHub config source creates no CodeCommit repo", () => {
  const { template } = synth({
    configSource: "github",
    configRepoName: "acme/dataspace-config",
    connectionArn:
      "arn:aws:codeconnections:eu-central-1:111111111111:connection/abc",
  });
  template.resourceCountIs("AWS::CodeCommit::Repository", 0);
});

test("pipeline synth passes the deployment name to the guard", () => {
  const { template } = synth({});
  const specs = JSON.stringify(
    template.findResources("AWS::CodeBuild::Project"),
  );
  expect(specs).toContain("--context deployment-name=Acme");
});
