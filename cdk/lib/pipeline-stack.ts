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
import {
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
    const stageId = deploymentName;

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
        deploymentName,
      }),
    );

    const recover = this.recoverFailedStacksStep(deploymentName);
    if (config.requireApproval) {
      const approve = new ManualApprovalStep("Approve");
      recover.addStepDependency(approve);
      stage.addPre(approve);
    }
    stage.addPre(recover);

    stage.addPost(
      this.portalFinalizationStep(configSource, cdkBundle, deploymentName),
    );
  }

  private stackArn(stackName: string): string {
    return `arn:aws:cloudformation:${this.region}:${this.account}:stack/${stackName}/*`;
  }

  /**
   * Deletes connector and BaSyx stacks left in ROLLBACK_COMPLETE by a failed
   * first create. CloudFormation accepts no change set for such a stack, so
   * without this every later run fails in Prepare. The stack holds no
   * resources, and its rollback already removed the portal registration.
   */
  private recoverFailedStacksStep(deploymentName: string): CodeBuildStep {
    const connectors = `${deploymentName}-Connector-`;
    const basyx = basyxStackName(deploymentName, "");
    return new CodeBuildStep("RecoverFailedStacks", {
      commands: [
        `STACKS=$(aws cloudformation list-stacks --stack-status-filter ROLLBACK_COMPLETE --query "StackSummaries[?starts_with(StackName, '${connectors}') || starts_with(StackName, '${basyx}')].StackName" --output text)`,
        `for s in $STACKS; do echo "Deleting $s (ROLLBACK_COMPLETE)"; aws cloudformation delete-stack --stack-name "$s"; aws cloudformation wait stack-delete-complete --stack-name "$s"; done`,
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

  /**
   * Post-deploy finalization: the BaSyx DTR offers, and deletion of connector
   * and BaSyx stacks whose config is gone (a connector stack's delete removes
   * its portal registration). Reuses the compiled CDK bundle from Synth.
   */
  private portalFinalizationStep(
    configSource: IFileSetProducer,
    cdkBundle: FileSet,
    deploymentName: string,
  ): CodeBuildStep {
    const connectorStackArn = this.stackArn(`${deploymentName}-Connector-*`);
    const basyxStackArn = this.stackArn(basyxStackName(deploymentName, "*"));
    const sharedInfraStackArn = this.stackArn(`${deploymentName}-SharedInfra`);

    return new CodeBuildStep("PortalFinalization", {
      input: configSource,
      additionalInputs: { "cdk-bundle": cdkBundle },
      installCommands: ["n 24"],
      commands: [
        `node cdk-bundle/dist/portal/finalize.js --config-path=. --stack-prefix=${deploymentName}`,
      ],
      rolePolicyStatements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          // Read-only on SharedInfra (API base URLs), connector and BaSyx stacks.
          actions: ["cloudformation:DescribeStacks"],
          resources: [sharedInfraStackArn, connectorStackArn, basyxStackArn],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          // Finds orphan stacks; the action has no resource-level permissions.
          actions: ["cloudformation:ListStacks"],
          resources: ["*"],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          // Orphan cleanup deletes connector and BaSyx stacks only, never SharedInfra.
          actions: [
            "cloudformation:DeleteStack",
            "cloudformation:DescribeStackEvents",
          ],
          resources: [connectorStackArn, basyxStackArn],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          // DTR asset reconcile on the connectors' management API.
          actions: ["execute-api:Invoke"],
          resources: [
            `arn:aws:execute-api:${this.region}:${this.account}:*/management/*`,
          ],
        }),
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
