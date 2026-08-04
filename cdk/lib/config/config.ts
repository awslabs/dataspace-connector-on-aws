// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration for GitOps-driven deployment via CDK Pipelines.
 *
 * YAML is the single source of configuration. This module defines the shape of
 * the three config files (pipeline.yaml, deployment.yaml, connectors/*.yaml),
 * loads and validates them, and exposes the small transform helpers the stacks
 * use to turn YAML values into CDK constructs.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

import { RemovalPolicy } from "aws-cdk-lib";
import { ArnPrincipal, IPrincipal } from "aws-cdk-lib/aws-iam";
import * as yaml from "js-yaml";

export type DeploymentProfile = "development" | "production";

// ─── pipeline.yaml ────────────────────────────────────────────────────────────

export interface PipelineYaml {
  readonly appRepo: string;
  readonly appVersion: string;
  readonly configSource: "codecommit" | "github";
  /** External repo (owner/name) for configSource=github. For codecommit the repo is derived as `${deploymentName}-config`. */
  readonly configRepoName?: string;
  readonly connectionArn?: string;
  readonly requireApproval?: boolean;
  /** Namespaces all resources so instances coexist in one account/region. Default "DataspaceConnector". Set once at bootstrap. */
  readonly deploymentName?: string;
}

// ─── deployment.yaml ──────────────────────────────────────────────────────────

export interface PortalIdentity {
  readonly trustedIssuer: string;
  readonly stsOauthTokenUrl: string;
  readonly stsDimUrl: string;
  readonly participantId: string;
  readonly dcpId: string;
  readonly didResolver: string;
}

export interface PortalConfig {
  readonly environment: "beta" | "production";
  /** Deployment-wide default identity. Each field is an optional fallback a connector may override. */
  readonly identity?: Partial<PortalIdentity>;
}

export interface DeploymentYaml {
  readonly profile: DeploymentProfile;
  readonly vpcIpAddresses: string;
  readonly containerInsights: boolean;
  readonly managementApiPrincipals: string[];
  readonly observabilityApiPrincipals: string[];
  readonly certificateArn?: string;
  readonly domainName?: string;
  readonly hostedZoneId?: string;
  readonly portal: PortalConfig;
}

// ─── connectors/connector-*.yaml ──────────────────────────────────────────────

export interface EdcIam {
  readonly trustedIssuer: string;
  readonly stsOauthTokenUrl: string;
  readonly stsOauthClientId: string;
  readonly stsDimUrl: string;
  readonly participantId: string;
  readonly dcpId: string;
  readonly didResolver: string;
}

/** Optional per-connector identity override, merged over the deployment default. */
export interface ConnectorPortalOverride {
  readonly identity?: Partial<PortalIdentity>;
}

export interface ConnectorYaml {
  readonly connectorId: string;
  readonly profile?: DeploymentProfile;
  readonly controlPlaneCpu: number;
  readonly controlPlaneMemoryLimitMiB: number;
  readonly dataPlaneCpu: number;
  readonly dataPlaneMemoryLimitMiB: number;
  /** Iteration interval (ms) for the negotiation, transfer, and data-flow state machines. Default "10000". */
  readonly interactiveStateMachineIterationMillis?: string;
  /** Iteration interval (ms) for the policy monitor and data-plane selector state machines. Default "60000". */
  readonly backgroundStateMachineIterationMillis?: string;
  readonly edcStateRemovalPolicy: "DESTROY" | "RETAIN";
  /** Cofinity-X portal technical user (service account) ID, authored by the operator. */
  readonly serviceAccountId: string;
  /** Per-connector identity override, merged over the deployment default. */
  readonly portal?: ConnectorPortalOverride;
}

/** Loaded deployment configuration (raw YAML, validated). */
export interface DeploymentConfig {
  readonly deployment: DeploymentYaml;
  readonly connectors: ConnectorYaml[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maps friendly edcIam fields to the EDC container environment variable names. */
export const EDC_IAM_ENVIRONMENT_VARIABLE_KEYS = {
  trustedIssuer: "edc.iam.trusted-issuer.issuer-1.id",
  stsOauthTokenUrl: "edc.iam.sts.oauth.token.url",
  stsOauthClientId: "edc.iam.sts.oauth.client.id",
  stsDimUrl: "tx.edc.iam.sts.dim.url",
  participantId: "tractusx.edc.participant.bpn",
  dcpId: "edc.iam.issuer.id",
  didResolver: "tx.edc.iam.iatp.bdrs.server.url",
} as const satisfies Record<keyof EdcIam, string>;

export const EDC_SECRETS_MANAGER_ALIASES = {
  DCP_STS_OAUTH_CLIENT_SECRET_ALIAS: "edc.iam.sts.oauth.client.secret",
  TOKEN_SIGNER_PRIVATE_KEY: "edc.transfer.proxy.token.signer.privatekey",
  TOKEN_VERIFIER_PUBLIC_KEY: "edc.transfer.proxy.token.verifier.publickey",
};

/** Identity fields required for a connector to be deployable. */
const PORTAL_IDENTITY_KEYS: (keyof PortalIdentity)[] = [
  "trustedIssuer",
  "stsOauthTokenUrl",
  "stsDimUrl",
  "participantId",
  "dcpId",
  "didResolver",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * connectorId constraints (must be compatible with all usage sites):
 * lowercase alphanumeric + hyphens, 2–60 chars, no leading/trailing hyphen.
 * Used in ALB paths, URL rewrite regex, API Gateway paths, Secrets Manager
 * prefixes, CloudFormation stack names, DynamoDB table names, ECS runtime IDs.
 */
export function validateConnectorId(connectorId: string): void {
  if (!/^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$/.test(connectorId)) {
    throw new Error(
      `Invalid connectorId "${connectorId}". Must be 2-60 chars, lowercase alphanumeric + hyphens, cannot start/end with hyphen.`,
    );
  }
}

/**
 * Derives a deterministic ALB listener rule priority from a connectorId,
 * independent of array ordering (safe for dynamically discovered YAML files).
 */
export function connectorPriority(connectorId: string): number {
  let hash = 0;
  for (const ch of connectorId) {
    hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  }
  return (Math.abs(hash) % 49999) + 1;
}

/** Converts a connector's resolved edcIam into EDC container environment variables. */
export function toEdcIamEnvVars(edcIam: EdcIam): Record<string, string> {
  return Object.fromEntries(
    (Object.keys(EDC_IAM_ENVIRONMENT_VARIABLE_KEYS) as (keyof EdcIam)[]).map(
      (key) => [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS[key], edcIam[key]],
    ),
  );
}

/** Merges the deployment-wide default identity with a connector's override. */
export function resolveConnectorIdentity(
  deployment: DeploymentYaml,
  connector: ConnectorYaml,
): Partial<PortalIdentity> {
  return {
    ...(deployment.portal.identity ?? {}),
    ...(connector.portal?.identity ?? {}),
  };
}

/** True when every identity field required for deployment is present and non-empty. */
export function isIdentityComplete(
  identity: Partial<PortalIdentity>,
): identity is PortalIdentity {
  return PORTAL_IDENTITY_KEYS.every(
    (key) => typeof identity[key] === "string" && identity[key] !== "",
  );
}

export const DEFAULT_DEPLOYMENT_NAME = "DataspaceConnector";

/** Resolves the deployment name (default "DataspaceConnector"); prefixes every named resource. */
export function resolveDeploymentName(pipeline: PipelineYaml): string {
  return pipeline.deploymentName ?? DEFAULT_DEPLOYMENT_NAME;
}

/** deploymentName prefixes stack, table, and secret names, so keep the charset conservative. */
export function validateDeploymentName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,40}$/.test(name)) {
    throw new Error(
      `Invalid deploymentName "${name}". Must be 1-41 chars, alphanumeric and hyphens, not starting with a hyphen.`,
    );
  }
}

/** Derives the per-tenant admin secret name, namespaced by deployment. */
export function deriveAdminSecretName(
  deploymentName: string,
  bpnl: string,
): string {
  return `${deploymentName}/portal-admin/${bpnl}`;
}

/** Derives a connector's Secrets Manager alias prefix, namespaced by deployment. */
export function deriveSecretPrefix(
  deploymentName: string,
  connectorId: string,
): string {
  return `${deploymentName}/${connectorId}/`;
}

/** Derives the EDC runtime DynamoDB table name, namespaced by deployment. */
export function deriveConnectorTableName(
  deploymentName: string,
  connectorId: string,
): string {
  return `${deploymentName}-${connectorId}`;
}

/** Maps the YAML removal-policy string to the CDK enum. */
export function toRemovalPolicy(value: "DESTROY" | "RETAIN"): RemovalPolicy {
  return value === "RETAIN" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
}

/** Wraps IAM role ARN strings as principals. */
export function toPrincipals(arns?: string[] | null): IPrincipal[] {
  return (arns ?? []).map((arn) => new ArnPrincipal(arn));
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Loads and validates deployment configuration from YAML files at configPath.
 * Throws if required files or fields are missing. Deploy-gating (which
 * connectors reached IDENTITY_READY) is applied by the deployment stage using
 * provision's ephemeral edcIam map, not here.
 */
export function loadDeploymentConfig(configPath: string): DeploymentConfig {
  const deploymentPath = join(configPath, "deployment.yaml");
  if (!existsSync(deploymentPath)) {
    throw new Error(`deployment.yaml not found at ${deploymentPath}`);
  }

  const deployment = yaml.load(
    readFileSync(deploymentPath, "utf-8"),
  ) as DeploymentYaml;
  validateDeployment(deployment, deploymentPath);

  const connectorsDir = join(configPath, "connectors");
  const files = existsSync(connectorsDir)
    ? readdirSync(connectorsDir).filter(
        (f) => f.startsWith("connector-") && f.endsWith(".yaml"),
      )
    : [];

  if (files.length === 0) {
    throw new Error(
      `No connector YAML files found in ${connectorsDir}. Add at least one connector-*.yaml file.`,
    );
  }

  const connectors = files.map((file) => {
    const connector = yaml.load(
      readFileSync(join(connectorsDir, file), "utf-8"),
    ) as ConnectorYaml;
    validateConnector(connector, file);
    return connector;
  });

  return { deployment, connectors };
}

function validateDeployment(data: DeploymentYaml, filePath: string): void {
  const required: (keyof DeploymentYaml)[] = [
    "profile",
    "vpcIpAddresses",
    "containerInsights",
    "portal",
  ];
  const missing = required.filter(
    (key) => data[key] === undefined || data[key] === null,
  );
  if (missing.length > 0) {
    throw new Error(
      `${filePath}: missing required fields: ${missing.join(", ")}`,
    );
  }
  if (!["development", "production"].includes(data.profile)) {
    throw new Error(
      `${filePath}: profile must be "development" or "production", got "${data.profile}"`,
    );
  }
  if (!data.portal.environment) {
    throw new Error(`${filePath}: portal section requires 'environment'`);
  }
}

function validateConnector(data: ConnectorYaml, fileName: string): void {
  const required: (keyof ConnectorYaml)[] = [
    "connectorId",
    "controlPlaneCpu",
    "controlPlaneMemoryLimitMiB",
    "dataPlaneCpu",
    "dataPlaneMemoryLimitMiB",
    "edcStateRemovalPolicy",
    "serviceAccountId",
  ];
  const missing = required.filter(
    (key) => data[key] === undefined || data[key] === null,
  );
  if (missing.length > 0) {
    throw new Error(
      `${fileName}: missing required fields: ${missing.join(", ")}`,
    );
  }
  validateConnectorId(data.connectorId);
}
