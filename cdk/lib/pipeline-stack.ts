// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { LinuxArmBuildImage, LinuxBuildImage } from "aws-cdk-lib/aws-codebuild";
import { Code, Repository } from "aws-cdk-lib/aws-codecommit";
import { PipelineType } from "aws-cdk-lib/aws-codepipeline";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { resolve } from "path";

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
import { DeploymentConfig, PipelineYaml } from "./config/config";

const STAGE_ID = "Deploy";
const ADMIN_SECRET_NAME = "dataspace-connector/portal-admin";
const CONNECTOR_STACK_PREFIX = `${STAGE_ID}-DataspaceConnector`;

export interface PipelineStackProps extends StackProps {
  readonly pipelineConfig: PipelineYaml;
  readonly deploymentConfig: DeploymentConfig;
}

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const config = props.pipelineConfig;

    // The stack owns the admin credentials secret (so its ARN is known for
    // least-privilege scoping); the value — the Cofinity-X portal technical
    // user's clientId and clientSecret as JSON — is populated out-of-band by
    // deploy.sh and never enters CloudFormation.
    const adminSecret = new Secret(this, "PortalAdminSecret", {
      secretName: ADMIN_SECRET_NAME,
      description:
        "Cofinity-X Portal admin technical user credentials (JSON: clientId, clientSecret)",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const configSource =
      config.configSource === "github"
        ? CodePipelineSource.connection(config.configRepoName, "main", {
            connectionArn: config.connectionArn!,
          })
        : CodePipelineSource.codeCommit(
            this.getOrCreateConfigRepo(config.configRepoName),
            "main",
          );

    // ─── Synth (clones the app, builds EDC, provisions portal identity) ──

    const synth = new CodeBuildStep("Synth", {
      input: configSource,
      buildEnvironment: { buildImage: LinuxBuildImage.STANDARD_7_0 },
      env: { PORTAL_ADMIN_SECRET: ADMIN_SECRET_NAME },
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
          resources: [adminSecret.secretArn],
        }),
      ],
    });

    // Reuse the compiled CDK bundle in the finalization step — no re-clone/build.
    const cdkBundle = synth.addOutputDirectory("app/cdk");

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

    const stage = pipeline.addStage(
      new DeploymentStage(this, STAGE_ID, { config: props.deploymentConfig }),
    );

    if (config.requireApproval) {
      stage.addPre(new ManualApprovalStep("Approve"));
    }

    stage.addPost(
      this.portalFinalizationStep(configSource, cdkBundle, adminSecret),
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
    adminSecret: ISecret,
  ): CodeBuildStep {
    const connectorSecretArn = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*/edc.iam.sts.oauth.client.secret-*`;
    const connectorStackArn = `arn:aws:cloudformation:${this.region}:${this.account}:stack/${CONNECTOR_STACK_PREFIX}*/*`;

    return new CodeBuildStep("PortalFinalization", {
      input: configSource,
      additionalInputs: { "cdk-bundle": cdkBundle },
      env: { PORTAL_ADMIN_SECRET: ADMIN_SECRET_NAME },
      installCommands: ["n 24"],
      commands: [
        // Config files are at the input root; compiled scripts + node_modules
        // come from the Synth bundle.
        `node cdk-bundle/dist/portal/finalize.js --config-path=. --stack-prefix=${STAGE_ID}`,
      ],
      rolePolicyStatements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["secretsmanager:GetSecretValue"],
          resources: [adminSecret.secretArn],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["secretsmanager:PutSecretValue"],
          resources: [connectorSecretArn],
        }),
        // ListStacks does not support resource-level scoping; the mutating
        // actions are scoped to the connector stack namespace.
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["cloudformation:ListStacks"],
          resources: ["*"],
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
