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

import {
  DeploymentConfig,
  loadDeploymentConfig,
  loadPipelineConfig,
  PersistenceType,
  PipelineYaml,
} from "../lib/config/config";
import { PipelineStack, runtimeJarTasks } from "../lib/pipeline-stack";

const TEMPLATES = join(__dirname, "..", "config-templates");
const env = { account: "111111111111", region: "eu-central-1" };

function synth(
  pipeline: Partial<PipelineYaml>,
  seedPath = TEMPLATES,
  deploymentConfig: DeploymentConfig = loadDeploymentConfig(TEMPLATES),
) {
  const app = new App({ outdir: mkdtempSync(join(tmpdir(), "pipeline-")) });
  const stack = new PipelineStack(app, "AcmePipelineStack", {
    pipelineConfig: {
      appRepo: "awslabs/dataspace-connector-on-aws",
      appVersion: "main",
      deploymentName: "Acme",
      ...pipeline,
    },
    deploymentConfig,
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

/** The bundled templates with one connector per given persistence type. */
function config(...types: PersistenceType[]): DeploymentConfig {
  const loaded = loadDeploymentConfig(TEMPLATES);
  return {
    ...loaded,
    connectors: types.map((persistence, i) => ({
      ...loaded.connectors[0],
      connectorId: `conn-${i}`,
      persistence,
    })),
  };
}

/** The shell commands of the Synth CodeBuild project. */
function synthCommands(deploymentConfig: DeploymentConfig): string[] {
  const { template } = synth(
    loadPipelineConfig(TEMPLATES),
    TEMPLATES,
    deploymentConfig,
  );
  const buildSpecs = Object.values(
    template.findResources("AWS::CodeBuild::Project"),
  ).map((r) => JSON.stringify(r.Properties.Source.BuildSpec));
  const synthSpec = buildSpecs.find((spec) => spec.includes("cdk synth"));
  expect(synthSpec).toBeDefined();
  return Object.values(JSON.parse(JSON.parse(synthSpec!)).phases).flatMap(
    (phase) => (phase as { commands: string[] }).commands,
  );
}

const gradleCommand = (deploymentConfig: DeploymentConfig) =>
  synthCommands(deploymentConfig).filter((c) => c.includes("gradlew"));

describe("runtimeJarTasks", () => {
  test.each([
    [["dynamodb"], ["shadowJar"]],
    [["postgres"], ["postgresShadowJar"]],
    [
      ["dynamodb", "postgres"],
      ["shadowJar", "postgresShadowJar"],
    ],
    [[], []],
  ] as [PersistenceType[], string[]][])("%j -> %j", (types, tasks) => {
    expect(runtimeJarTasks(new Set(types))).toEqual(tasks);
  });
});

describe("PipelineStack Synth step", () => {
  test("dynamodb only: builds the DynamoDB jars alone", () => {
    expect(gradleCommand(config("dynamodb", "dynamodb"))).toEqual([
      "cd edc && ./gradlew clean shadowJar",
    ]);
  });

  test("postgres only: builds the PostgreSQL jars alone", () => {
    expect(gradleCommand(config("postgres", "postgres"))).toEqual([
      "cd edc && ./gradlew clean postgresShadowJar",
    ]);
  });

  test("mixed: builds both variants in one Gradle invocation", () => {
    expect(gradleCommand(config("postgres", "dynamodb"))).toEqual([
      "cd edc && ./gradlew clean shadowJar postgresShadowJar",
    ]);
  });
});

test("CleanUpStacks deletes a SharedInfra stack only in ROLLBACK_COMPLETE, after its dependents", () => {
  const { template } = synth({});
  const [keep, loop] = Object.values(
    template.findResources("AWS::CodeBuild::Project"),
  )
    .map((r) => JSON.parse(r.Properties.Source.BuildSpec))
    .find((spec) => JSON.stringify(spec).includes("delete-stack")).phases
    .build.commands;
  expect(keep).toBe('KEEP=" Acme-SharedInfra Acme-Connector-example "');
  expect(loop).toMatch(
    /^for p in Acme-BaSyx- Acme-Connector- Acme-SharedInfra; do /,
  );
  expect(loop).toContain('[ "$status" = ROLLBACK_COMPLETE ] || continue');
});
