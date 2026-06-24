// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Stack, StackProps } from "aws-cdk-lib";
import { LinuxArmBuildImage, LinuxBuildImage } from "aws-cdk-lib/aws-codebuild";
import { Repository } from "aws-cdk-lib/aws-codecommit";
import { PipelineType } from "aws-cdk-lib/aws-codepipeline";

import { Construct } from "constructs";

import {
  CodeBuildStep,
  CodePipeline,
  CodePipelineSource,
  ManualApprovalStep,
} from "aws-cdk-lib/pipelines";

import { DeploymentStage } from "./deployment-stage";
import { DeploymentConfig } from "./config/environments";
import { PipelineYaml } from "./config/schemas";

export interface PipelineStackProps extends StackProps {
  readonly pipelineConfig: PipelineYaml;
  readonly deploymentConfig: DeploymentConfig;
}

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const config = props.pipelineConfig;

    // Config repo source (trigger)
    const configSource =
      config.configSource === "github"
        ? CodePipelineSource.connection(config.configRepoName, "main", {
            connectionArn: config.connectionArn!,
          })
        : CodePipelineSource.codeCommit(
            this.getOrCreateConfigRepo(config.configRepoName),
            "main",
          );

    // Synth step: clone app repo at pinned version, build, synth
    const synth = new CodeBuildStep("Synth", {
      input: configSource,
      buildEnvironment: {
        buildImage: LinuxBuildImage.STANDARD_7_0,
      },
      installCommands: ["n 24"],
      commands: [
        // Read appVersion from pipeline.yaml
        `APP_VERSION=$(grep 'appVersion:' pipeline.yaml | awk '{print $2}')`,
        `echo "Using app version: $APP_VERSION"`,
        // Clone app repo at specific version
        `git clone https://github.com/${config.appRepo}.git app`,
        `cd app && git checkout "$APP_VERSION"`,
        // Build EDC extensions
        `cd edc && ./gradlew clean shadowJar`,
        // Install CDK dependencies and compile
        `cd ../cdk && npm ci --ignore-scripts && npx tsc`,
        // Synth with config path pointing to the config repo root
        `npx cdk synth --app 'node dist/pipeline-app.js' --context config-path=../..`,
      ],
      primaryOutputDirectory: "app/cdk/build/cdk.out",
    });

    const pipeline = new CodePipeline(this, "Pipeline", {
      pipelineName: "DataspaceConnectorPipeline",
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

    // Deploy stage (SharedInfra + all Connectors in parallel)
    const deployStage = new DeploymentStage(this, "Deploy", {
      config: props.deploymentConfig,
    });

    const stage = pipeline.addStage(deployStage);

    // Optional manual approval before deploy
    if (config.requireApproval) {
      stage.addPre(new ManualApprovalStep("Approve"));
    }

    // Orphan cleanup step: destroy stacks for removed connectors
    const expectedConnectors = props.deploymentConfig.connectors
      .map((c) => `DataspaceConnector-${c.connectorId}`)
      .join(" ");

    stage.addPost(
      new CodeBuildStep("CleanupOrphans", {
        commands: [
          `EXPECTED="${expectedConnectors}"`,
          `DEPLOYED=$(aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE --query "StackSummaries[?starts_with(StackName,'DataspaceConnector-')].StackName" --output text)`,
          `for stack in $DEPLOYED; do if ! echo "$EXPECTED" | grep -qw "$stack"; then echo "Destroying orphaned stack: $stack"; aws cloudformation delete-stack --stack-name "$stack"; aws cloudformation wait stack-delete-complete --stack-name "$stack" --cli-read-timeout 600; fi; done`,
        ],
      }),
    );
  }

  private getOrCreateConfigRepo(repoName: string): Repository {
    return new Repository(this, "ConfigRepo", {
      repositoryName: repoName,
      description:
        "Configuration repository for Dataspace Connector on AWS deployments",
    });
  }
}
