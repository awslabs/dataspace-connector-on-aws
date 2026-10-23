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
  ManualApprovalStep,
} from "aws-cdk-lib/pipelines";

import { DeploymentStage } from "./deployment-stage";
import {
  basyxEntries,
  basyxStackName,
  DeploymentConfig,
  PipelineYaml,
  resolveDeploymentName,
} from "./config/config";
import { resolve } from "path";

export interface PipelineStackProps extends StackProps {
  readonly pipelineConfig: PipelineYaml;
  readonly deploymentConfig: DeploymentConfig;
}

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const config = props.pipelineConfig;
    const deploymentName = resolveDeploymentName(config);

    const configSource =
      config.configSource === "github"
        ? CodePipelineSource.connection(config.configRepoName!, "main", {
            connectionArn: config.connectionArn!,
          })
        : CodePipelineSource.codeCommit(
            new Repository(this, "ConfigRepo", {
              repositoryName: `${deploymentName}-config`,
              description:
                "Configuration repository for Dataspace Connector on AWS deployments",
              code: Code.fromDirectory(
                resolve(__dirname, "../config-templates"),
                "main",
              ),
            }),
            "main",
          );

    const synth = new CodeBuildStep("Synth", {
      input: configSource,
      buildEnvironment: { buildImage: LinuxBuildImage.STANDARD_7_0 },
      installCommands: ["n 24"],
      commands: [
        `APP_VERSION=$(python3 -c "import yaml; print(yaml.safe_load(open('pipeline.yaml'))['appVersion'])")`,
        `echo "Using app version: $APP_VERSION"`,
        `git clone https://github.com/${config.appRepo}.git app`,
        `cd app && git checkout "$APP_VERSION"`,
        `cd edc && ./gradlew clean shadowJar`,
        `cd ../cdk && npm ci --ignore-scripts && npx tsc`,
        `npx cdk synth --app 'node dist/app.js' --context config-path=../..`,
      ],
      primaryOutputDirectory: "app/cdk/build/cdk.out",
    });

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
      new DeploymentStage(this, deploymentName, {
        config: props.deploymentConfig,
        deploymentName,
      }),
    );

    const cleanUp = this.cleanUpStacksStep(
      deploymentName,
      props.deploymentConfig,
    );
    if (config.requireApproval) {
      const approve = new ManualApprovalStep("Approve");
      cleanUp.addStepDependency(approve);
      stage.addPre(approve);
    }
    stage.addPre(cleanUp);
  }

  private stackArn(stackName: string): string {
    return `arn:aws:cloudformation:${this.region}:${this.account}:stack/${stackName}/*`;
  }

  /**
   * Before the deploy, deletes the BaSyx and connector stacks whose config is
   * gone, BaSyx first, and any left in ROLLBACK_COMPLETE by a failed first
   * create, which accept no change set. CDK Pipelines never deletes a stack
   * itself. A connector stack's delete removes its portal registration, a
   * BaSyx stack's delete its DTR offer.
   */
  private cleanUpStacksStep(
    deploymentName: string,
    config: DeploymentConfig,
  ): CodeBuildStep {
    const connectors = `${deploymentName}-Connector-`;
    const basyx = basyxStackName(deploymentName, "");
    const keep = [
      ...config.connectors.map((c) => `${connectors}${c.connectorId}`),
      ...basyxEntries(config).map((b) =>
        basyxStackName(deploymentName, b.bpnl),
      ),
    ];
    return new CodeBuildStep("CleanUpStacks", {
      commands: [
        `KEEP=" ${keep.join(" ")} "`,
        [
          `for p in ${basyx} ${connectors}; do`,
          `aws cloudformation list-stacks --query "StackSummaries[?StackStatus!='DELETE_COMPLETE' && starts_with(StackName, '$p')].[StackName,StackStatus]" --output text |`,
          `while read -r s status; do`,
          `case "$KEEP" in *" $s "*) [ "$status" = ROLLBACK_COMPLETE ] || continue;; esac;`,
          `echo "Deleting $s ($status)";`,
          `aws cloudformation delete-stack --stack-name "$s" && aws cloudformation wait stack-delete-complete --stack-name "$s" || exit 1;`,
          `done || exit 1;`,
          `done`,
        ].join(" "),
      ],
      rolePolicyStatements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          // The action has no resource-level permissions.
          actions: ["cloudformation:ListStacks"],
          resources: ["*"],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "cloudformation:DeleteStack",
            "cloudformation:DescribeStacks",
          ],
          resources: [
            this.stackArn(`${connectors}*`),
            this.stackArn(`${basyx}*`),
          ],
        }),
      ],
    });
  }
}
