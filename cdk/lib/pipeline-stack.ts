// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "path";
import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { LinuxArmBuildImage, LinuxBuildImage } from "aws-cdk-lib/aws-codebuild";
import { Code, Repository } from "aws-cdk-lib/aws-codecommit";
import { PipelineType } from "aws-cdk-lib/aws-codepipeline";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";

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
import { DeploymentConfig } from "./config/environments";
import { PipelineYaml } from "./config/schemas";

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
    const portalConfig = props.deploymentConfig.portal;

    // Portal integration is opt-in. When configured, the pipeline provisions
    // EDC identity credentials from the Cofinity-X Portal and registers
    // connectors for discovery. The portal registry is the source of truth —
    // no DSCA-side state is persisted. When not configured, connectors supply
    // edcIam values directly and orphan cleanup enumerates CloudFormation stacks.
    //
    // The stack owns the admin credentials secret (so its ARN is known for
    // least-privilege scoping); the value is populated out-of-band by
    // deploy-pipeline.sh and never enters CloudFormation.
    const adminSecret = portalConfig ? this.createAdminSecret() : undefined;

    // ─── Config Source ───────────────────────────────────────────────────

    const configSource =
      config.configSource === "github"
        ? CodePipelineSource.connection(config.configRepoName, "main", {
            connectionArn: config.connectionArn!,
          })
        : CodePipelineSource.codeCommit(
            this.getOrCreateConfigRepo(config.configRepoName),
            "main",
          );

    // ─── Synth Step ──────────────────────────────────────────────────────

    const synth = new CodeBuildStep("Synth", {
      input: configSource,
      buildEnvironment: { buildImage: LinuxBuildImage.STANDARD_7_0 },
      env: adminSecret ? { PORTAL_ADMIN_SECRET: ADMIN_SECRET_NAME } : undefined,
      installCommands: ["n 24"],
      commands: [
        // Read appVersion from pipeline.yaml
        `APP_VERSION=$(python3 -c "import yaml; print(yaml.safe_load(open('pipeline.yaml'))['appVersion'])")`,
        `echo "Using app version: $APP_VERSION"`,
        // Clone app repo at specific version
        `git clone https://github.com/${config.appRepo}.git app`,
        `cd app && git checkout "$APP_VERSION"`,
        // Build EDC extensions
        `cd edc && ./gradlew clean shadowJar`,
        // Install CDK dependencies and compile
        `cd ../cdk && npm ci --ignore-scripts && npx tsc`,
        // Portal provisioning populates edcIam for connectors declaring an
        // edcTechnicalUserId. No-op when the portal section is absent.
        ...(portalConfig
          ? [`node dist/portal/provision.js --config-path=../..`]
          : []),
        // Synth with the (possibly portal-populated) connector YAMLs
        `npx cdk synth --app 'node dist/pipeline-app.js' --context config-path=../..`,
      ],
      primaryOutputDirectory: "app/cdk/build/cdk.out",
      rolePolicyStatements: adminSecret
        ? this.provisionPolicyStatements(adminSecret)
        : undefined,
    });

    // Capture the compiled CDK directory (dist/ + node_modules) so the
    // post-deploy finalization step can run the portal scripts without
    // re-cloning the app repo or rebuilding.
    const cdkBundle: FileSet | undefined = portalConfig
      ? synth.addOutputDirectory("app/cdk")
      : undefined;

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

    // ─── Deploy Stage ───────────────────────────────────────────────────

    const deployStage = new DeploymentStage(this, STAGE_ID, {
      config: props.deploymentConfig,
    });

    const stage = pipeline.addStage(deployStage);

    if (config.requireApproval) {
      stage.addPre(new ManualApprovalStep("Approve"));
    }

    // ─── Post-Deploy Cleanup / Finalization ─────────────────────────────

    if (adminSecret && cdkBundle) {
      stage.addPost(
        this.portalFinalizationStep(configSource, cdkBundle, adminSecret),
      );
    } else {
      stage.addPost(
        this.cloudFormationOrphanCleanupStep(props.deploymentConfig),
      );
    }
  }

  // ─── Admin Secret ─────────────────────────────────────────────────────

  /**
   * Creates the (empty) admin credentials secret. The value — the Cofinity-X
   * portal technical user's clientId and clientSecret as JSON — is populated by
   * deploy-pipeline.sh, keeping it out of CloudFormation.
   */
  private createAdminSecret(): Secret {
    return new Secret(this, "PortalAdminSecret", {
      secretName: ADMIN_SECRET_NAME,
      description:
        "Cofinity-X Portal admin technical user credentials (JSON: clientId, clientSecret)",
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  // ─── IAM Policy Builders ────────────────────────────────────────────────

  /** Permissions for the pre-synth provisioning script. */
  private provisionPolicyStatements(adminSecret: ISecret): PolicyStatement[] {
    return [
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [adminSecret.secretArn],
      }),
    ];
  }

  /** Permissions for the post-deploy finalization script. */
  private finalizePolicyStatements(adminSecret: ISecret): PolicyStatement[] {
    const connectorSecretArn = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*/edc.iam.sts.oauth.client.secret-*`;
    const connectorStackArn = `arn:aws:cloudformation:${this.region}:${this.account}:stack/${CONNECTOR_STACK_PREFIX}*/*`;

    return [
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
    ];
  }

  // ─── Post-Deploy Steps ──────────────────────────────────────────────────

  /**
   * Portal-integrated finalization: writes OAuth secrets, registers new
   * connectors, and cleans up orphans (portal deregistration + stack deletion).
   * Reuses the compiled CDK bundle from Synth — no clone or rebuild.
   */
  private portalFinalizationStep(
    configSource: IFileSetProducer,
    cdkBundle: FileSet,
    adminSecret: ISecret,
  ): CodeBuildStep {
    return new CodeBuildStep("PortalFinalization", {
      input: configSource,
      additionalInputs: { "cdk-bundle": cdkBundle },
      env: { PORTAL_ADMIN_SECRET: ADMIN_SECRET_NAME },
      installCommands: ["n 24"],
      commands: [
        // Config files (deployment.yaml, connectors/) are at the input root;
        // compiled portal scripts + node_modules come from the Synth bundle.
        `node cdk-bundle/dist/portal/finalize.js --config-path=. --stack-prefix=${STAGE_ID}`,
      ],
      rolePolicyStatements: this.finalizePolicyStatements(adminSecret),
    });
  }

  /**
   * Fallback orphan cleanup for non-portal deployments: destroys connector
   * stacks whose YAML files have been removed from the config repo.
   */
  private cloudFormationOrphanCleanupStep(
    deploymentConfig: DeploymentConfig,
  ): CodeBuildStep {
    const expectedConnectors = deploymentConfig.connectors
      .map((c) => `${CONNECTOR_STACK_PREFIX}-${c.connectorId}`)
      .join(" ");

    return new CodeBuildStep("CleanupOrphans", {
      commands: [
        `EXPECTED="${expectedConnectors}"`,
        `DEPLOYED=$(aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE --query "StackSummaries[?starts_with(StackName,'${CONNECTOR_STACK_PREFIX}-')].StackName" --output text)`,
        `for stack in $DEPLOYED; do if ! echo "$EXPECTED" | grep -qw "$stack"; then echo "Destroying orphaned stack: $stack"; aws cloudformation delete-stack --stack-name "$stack"; aws cloudformation wait stack-delete-complete --stack-name "$stack" --cli-read-timeout 600; fi; done`,
      ],
      rolePolicyStatements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "cloudformation:ListStacks",
            "cloudformation:DeleteStack",
            "cloudformation:DescribeStacks",
            "cloudformation:DescribeStackEvents",
          ],
          resources: ["*"], // ListStacks does not support resource-level scoping
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
