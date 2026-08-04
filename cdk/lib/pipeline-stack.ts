// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Stack, StackProps } from "aws-cdk-lib";
import { LinuxArmBuildImage, LinuxBuildImage } from "aws-cdk-lib/aws-codebuild";
import { Code, Repository } from "aws-cdk-lib/aws-codecommit";
import { PipelineType } from "aws-cdk-lib/aws-codepipeline";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";

import { Construct } from "constructs";

import {
  CodeBuildStep,
  CodePipeline,
  CodePipelineSource,
  FileSet,
  IFileSetProducer,
  ManualApprovalStep,
} from "aws-cdk-lib/pipelines";

import { DeploymentStage } from "./deployment-stage";
import { ConnectorStateTable } from "./constructs/connector-state-table";
import {
  DeploymentConfig,
  PipelineYaml,
  resolveDeploymentName,
} from "./config/config";
import { resolve } from "path";
import { ResolvedEdcIam } from "./portal/provision-output";

/** Least-privilege DynamoDB access to the connector state table for a pipeline step. */
function stateTablePolicy(stateTable: ConnectorStateTable): PolicyStatement {
  return new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    ],
    resources: [stateTable.table.tableArn],
  });
}

export interface PipelineStackProps extends StackProps {
  readonly pipelineConfig: PipelineYaml;
  readonly deploymentConfig: DeploymentConfig;
  readonly resolvedEdcIam: ResolvedEdcIam;
  readonly activeBpnls: string[];
}

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const config = props.pipelineConfig;
    const deploymentName = resolveDeploymentName(config);
    const stageId = deploymentName;

    // Cross-run portal integration state, read and written by provision and finalize.
    const stateTable = new ConnectorStateTable(
      this,
      "ConnectorState",
      `${deploymentName}-connector-state`,
    );

    if (
      config.configSource === "github" &&
      (!config.configRepoName || !config.connectionArn)
    ) {
      throw new Error(
        "pipeline.yaml: github configSource requires configRepoName and connectionArn.",
      );
    }

    const configSource =
      config.configSource === "github"
        ? CodePipelineSource.connection(config.configRepoName!, "main", {
            connectionArn: config.connectionArn!,
          })
        : CodePipelineSource.codeCommit(
            // CodeCommit repo name is derived from deploymentName so instances
            // never collide; the pipeline creates and seeds it.
            this.getOrCreateConfigRepo(`${deploymentName}-config`),
            "main",
          );

    // ─── Synth (clones the app, builds EDC, provisions portal identity) ──

    const synth = new CodeBuildStep("Synth", {
      input: configSource,
      buildEnvironment: { buildImage: LinuxBuildImage.STANDARD_7_0 },
      env: {
        STATE_TABLE_NAME: stateTable.table.tableName,
        DEPLOYMENT_NAME: deploymentName,
      },
      installCommands: ["n 24"],
      commands: [
        `APP_VERSION=$(python3 -c "import yaml; print(yaml.safe_load(open('pipeline.yaml'))['appVersion'])")`,
        `echo "Using app version: $APP_VERSION"`,
        `git clone https://github.com/${config.appRepo}.git app`,
        `cd app && git checkout "$APP_VERSION"`,
        `cd edc && ./gradlew clean shadowJar`,
        `cd ../cdk && npm ci --ignore-scripts && npx tsc`,
        // Populate each connector's edcIam from the portal before synth.
        `node dist/portal/provision.js --config-path=../..`,
        `npx cdk synth --app 'node dist/app.js' --context config-path=../..`,
      ],
      primaryOutputDirectory: "app/cdk/build/cdk.out",
      rolePolicyStatements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["secretsmanager:GetSecretValue"],
          resources: [
            `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${deploymentName}/portal-admin/*`,
          ],
        }),
        stateTablePolicy(stateTable),
      ],
    });

    // Reuse the compiled CDK bundle in the finalization step — no re-clone/build.
    const cdkBundle = synth.addOutputDirectory("app/cdk");

    const pipeline = new CodePipeline(this, "Pipeline", {
      pipelineName: `${deploymentName}Pipeline`,
      pipelineType: PipelineType.V2,
      synth,
      selfMutation: true,
      dockerEnabledForSelfMutation: true,
      assetPublishingCodeBuildDefaults: {
        buildEnvironment: {
          buildImage: LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
          privileged: true,
        },
      },
    });

    const stage = pipeline.addStage(
      new DeploymentStage(this, stageId, {
        config: props.deploymentConfig,
        resolvedEdcIam: props.resolvedEdcIam,
        activeBpnls: props.activeBpnls,
        deploymentName,
      }),
    );

    if (config.requireApproval) {
      stage.addPre(new ManualApprovalStep("Approve"));
    }

    stage.addPost(
      this.portalFinalizationStep(
        configSource,
        cdkBundle,
        stateTable,
        deploymentName,
      ),
    );
  }

  /**
   * Post-deploy finalization: writes OAuth secrets, registers new connectors,
   * and cleans up orphans (portal deregistration + stack deletion). Reuses the
   * compiled CDK bundle from Synth — no clone or rebuild.
   */
  private portalFinalizationStep(
    configSource: IFileSetProducer,
    cdkBundle: FileSet,
    stateTable: ConnectorStateTable,
    deploymentName: string,
  ): CodeBuildStep {
    const secretArn = `arn:aws:secretsmanager:${this.region}:${this.account}:secret`;
    const adminSecretArn = `${secretArn}:${deploymentName}/portal-admin/*`;
    const connectorSecretArn = `${secretArn}:${deploymentName}/*/edc.iam.sts.oauth.client.secret-*`;
    const connectorStackArn = `arn:aws:cloudformation:${this.region}:${this.account}:stack/${deploymentName}-Connector*/*`;

    return new CodeBuildStep("PortalFinalization", {
      input: configSource,
      additionalInputs: { "cdk-bundle": cdkBundle },
      env: {
        STATE_TABLE_NAME: stateTable.table.tableName,
        DEPLOYMENT_NAME: deploymentName,
      },
      installCommands: ["n 24"],
      commands: [
        `node cdk-bundle/dist/portal/finalize.js --config-path=. --stack-prefix=${deploymentName}`,
      ],
      rolePolicyStatements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["secretsmanager:GetSecretValue"],
          resources: [adminSecretArn],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["secretsmanager:PutSecretValue"],
          resources: [connectorSecretArn],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "cloudformation:DescribeStacks",
            "cloudformation:DeleteStack",
            "cloudformation:DescribeStackEvents",
          ],
          resources: [connectorStackArn],
        }),
        stateTablePolicy(stateTable),
      ],
    });
  }

  private getOrCreateConfigRepo(repoName: string): Repository {
    return new Repository(this, "ConfigRepo", {
      repositoryName: repoName,
      description:
        "Configuration repository for Dataspace Connector on AWS deployments",
      code: Code.fromDirectory(
        resolve(__dirname, "../config-templates"),
        "main",
      ),
    });
  }
}
