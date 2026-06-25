// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * YAML schema interfaces for GitOps-driven deployment via CDK Pipelines.
 * These define the shape of pipeline.yaml, deployment.yaml, and connector-*.yaml
 * files in the customer's config repository.
 */

// ─── pipeline.yaml ────────────────────────────────────────────────────────────

export interface PipelineYaml {
  readonly appRepo: string;
  readonly appVersion: string;
  readonly configSource: "codecommit" | "github";
  readonly configRepoName: string;
  readonly connectionArn?: string;
  readonly requireApproval?: boolean;
}

// ─── deployment.yaml ──────────────────────────────────────────────────────────

export interface DeploymentYaml {
  readonly profile: "development" | "production";
  readonly vpcIpAddresses: string;
  readonly containerInsights: boolean;
  readonly managementApiPrincipals: string[];
  readonly observabilityApiPrincipals: string[];
  readonly certificateArn?: string;
  readonly domainName?: string;
  readonly hostedZoneId?: string;
}

// ─── connectors/connector-*.yaml ──────────────────────────────────────────────

export interface ConnectorYaml {
  readonly connectorId: string;
  readonly profile?: "development" | "production";
  readonly controlPlaneCpu: number;
  readonly controlPlaneMemoryLimitMiB: number;
  readonly dataPlaneCpu: number;
  readonly dataPlaneMemoryLimitMiB: number;
  readonly stateMachineIterationMillis: string;
  readonly edcStateRemovalPolicy: "DESTROY" | "RETAIN";
  readonly edcIam: EdcIamYaml;
}

export interface EdcIamYaml {
  readonly trustedIssuer: string;
  readonly stsOauthTokenUrl: string;
  readonly stsOauthClientId: string;
  readonly stsDimUrl: string;
  readonly participantId: string;
  readonly dcpId: string;
  readonly didResolver: string;
}
