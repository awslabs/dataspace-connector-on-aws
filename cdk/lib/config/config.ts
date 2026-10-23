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

import {
  PORTAL_ENVIRONMENTS,
  PortalEnvironment,
  PortalEnvironmentSettings,
  STS_DIM_URL,
  companyDid,
} from "../portal-connector/client";

export type DeploymentProfile = "development" | "production";

export const LOG_LEVELS = [
  "TRACE",
  "DEBUG",
  "INFO",
  "WARN",
  "ERROR",
  "OFF",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** What happens to stored state (EDC DynamoDB/S3, BaSyx Aurora) when its stack is deleted. */
export const STATE_REMOVAL_POLICIES = ["DESTROY", "RETAIN"] as const;
export type StateRemovalPolicy = (typeof STATE_REMOVAL_POLICIES)[number];

export const BASYX_SERVICES = ["dtr", "submodelRepository"] as const;
export type BasyxService = (typeof BASYX_SERVICES)[number];

// ─── pipeline.yaml ────────────────────────────────────────────────────────────

export interface PipelineYaml {
  readonly appRepo: string;
  readonly appVersion: string;
  /** Default "codecommit". */
  readonly configSource?: "codecommit" | "github";
  /** External repo (owner/name) for configSource=github. For codecommit the repo is derived as `${deploymentName}-config`. */
  readonly configRepoName?: string;
  readonly connectionArn?: string;
  readonly requireApproval?: boolean;
  /** Namespaces all resources so instances coexist in one account/region. Default "DataspaceConnector". Set once at bootstrap. */
  readonly deploymentName?: string;
}

// ─── deployment.yaml ──────────────────────────────────────────────────────────

export interface PortalConfig {
  readonly environment: PortalEnvironment;
  /** Default BPNL of every connector; a connector may set its own. */
  readonly bpnl?: string;
}

export interface DeploymentYaml {
  /** Shared infrastructure and BaSyx profile. Default "development". */
  readonly profile: DeploymentProfile;
  /** VPC CIDR. Default "10.0.0.0/20". */
  readonly vpcIpAddresses: string;
  /** Default false. */
  readonly containerInsights: boolean;
  readonly managementApiPrincipals?: string[];
  readonly observabilityApiPrincipals?: string[];
  readonly certificateArn?: string;
  readonly domainName?: string;
  readonly hostedZoneId?: string;
  /** EDC log level for all connectors; a connector may override it. Unset keeps the Tractus-X default. */
  readonly logLevel?: LogLevel;
  readonly portal: PortalConfig;
  /** Removal policy for stored state; connectors and BaSyx entries may override it. Default RETAIN. */
  readonly stateRemovalPolicy: StateRemovalPolicy;
  /** Eclipse BaSyx (Digital Twin Registry + Submodel Repository) per BPNL, keyed by BPNL. */
  readonly basyx?: Record<string, BasyxEntry>;
}

/** One BaSyx deployment for one BPNL. */
export interface BasyxEntry {
  readonly services: BasyxService[];
  /** Connector that offers the DTR asset. Default: the BPNL's first connector (file name order). */
  readonly dtrConnector: string;
  /** Default: the deployment.yaml profile. */
  readonly profile: DeploymentProfile;
  /** Default: the deployment.yaml stateRemovalPolicy. */
  readonly stateRemovalPolicy: StateRemovalPolicy;
}

// ─── connectors/connector-*.yaml ──────────────────────────────────────────────

export interface ConnectorYaml {
  readonly connectorId: string;
  /** The connector's BPNL, overriding deployment.yaml portal.bpnl. */
  readonly bpnl?: string;
  /** Default "production", independent of the deployment.yaml profile. */
  readonly profile: DeploymentProfile;
  /** Fargate task sizes. Defaults 256 / 1024 / 256 / 512. */
  readonly controlPlaneCpu: number;
  readonly controlPlaneMemoryLimitMiB: number;
  readonly dataPlaneCpu: number;
  readonly dataPlaneMemoryLimitMiB: number;
  /** Negotiation, transfer and data-flow state machine interval (ms). Default 10000. */
  readonly interactiveStateMachineIterationMillis: number;
  /** Policy monitor and data-plane selector state machine interval (ms). Default 60000. */
  readonly backgroundStateMachineIterationMillis: number;
  /** Heartbeat (ms) of in-flight PULL flows; one DynamoDB write each. Default 10000. */
  readonly dataPlaneFlowLeaseMillis: number;
  /** Default: the deployment.yaml stateRemovalPolicy. */
  readonly stateRemovalPolicy: StateRemovalPolicy;
  /** Default: the deployment.yaml logLevel. */
  readonly logLevel?: LogLevel;
}

/** Loaded deployment configuration (raw YAML, validated). */
export interface DeploymentConfig {
  readonly deployment: DeploymentYaml;
  readonly connectors: ConnectorYaml[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * connectorId constraints (must be compatible with all usage sites):
 * lowercase alphanumeric + hyphens, 2–60 chars, no leading/trailing hyphen.
 * Used in ALB paths, URL rewrite regex, API Gateway paths, Secrets Manager
 * prefixes, CloudFormation stack names, DynamoDB table names, ECS runtime IDs.
 */
export function validateConnectorId(connectorId: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/.test(connectorId)) {
    throw new Error(
      `Invalid connectorId "${connectorId}". Must be 2-60 chars, lowercase alphanumeric + hyphens, cannot start/end with hyphen.`,
    );
  }
  // The first path segment of the BaSyx routes on the ALB and the management API.
  if (connectorId === "basyx") {
    throw new Error(`Invalid connectorId "basyx". The name is reserved.`);
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

/** A connector's BPNL: its own, else the deployment default. The loader guarantees one. */
export function connectorBpnl(
  deployment: DeploymentYaml,
  connector: ConnectorYaml,
): string {
  return (connector.bpnl ?? deployment.portal.bpnl)!;
}

/**
 * A connector's EDC identity settings. Everything but the technical user's
 * client id and token URL follows from the portal environment and the BPNL.
 */
export function edcIdentityEnvironment(
  environment: PortalEnvironment,
  bpnl: string,
  technicalUser: { clientId: string; stsOauthTokenUrl: string },
): Record<string, string> {
  const settings: PortalEnvironmentSettings = PORTAL_ENVIRONMENTS[environment];
  const did = companyDid(environment, bpnl);
  return {
    "edc.iam.trusted-issuer.issuer-1.id": settings.trustedIssuer,
    "edc.iam.sts.oauth.token.url": technicalUser.stsOauthTokenUrl,
    "edc.iam.sts.oauth.client.id": technicalUser.clientId,
    "tx.edc.iam.sts.dim.url": STS_DIM_URL,
    "tractusx.edc.participant.bpn": bpnl,
    "edc.iam.issuer.id": did,
    "edc.participant.id": did,
    "tx.edc.iam.iatp.bdrs.server.url": settings.didResolver,
  };
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
export function toRemovalPolicy(value: StateRemovalPolicy): RemovalPolicy {
  return value === "RETAIN" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
}

/** Wraps IAM role ARN strings as principals. */
export function toPrincipals(arns?: string[] | null): IPrincipal[] {
  return (arns ?? []).map((arn) => new ArnPrincipal(arn));
}

// ─── Allowed keys ─────────────────────────────────────────────────────────────

/**
 * Allowed keys per file and nesting level. `keys` describes a fixed object,
 * `mapOf` a map keyed by user values (e.g. BPNL) whose values follow the inner
 * spec. A leaf ({}) accepts any value; field checks validate its type. Each
 * level `satisfies Record<keyof T, ...>`, so a new interface field fails to
 * compile until it is listed here.
 */
interface KeySpec {
  readonly keys?: Readonly<Record<string, KeySpec>>;
  readonly mapOf?: KeySpec;
}

const LEAF: KeySpec = {};

const PIPELINE_KEY_SPEC: KeySpec = {
  keys: {
    appRepo: LEAF,
    appVersion: LEAF,
    configSource: LEAF,
    configRepoName: LEAF,
    connectionArn: LEAF,
    requireApproval: LEAF,
    deploymentName: LEAF,
  } satisfies Record<keyof PipelineYaml, KeySpec>,
};

const DEPLOYMENT_KEY_SPEC: KeySpec = {
  keys: {
    profile: LEAF,
    vpcIpAddresses: LEAF,
    containerInsights: LEAF,
    managementApiPrincipals: LEAF,
    observabilityApiPrincipals: LEAF,
    certificateArn: LEAF,
    domainName: LEAF,
    hostedZoneId: LEAF,
    logLevel: LEAF,
    portal: {
      keys: {
        environment: LEAF,
        bpnl: LEAF,
      } satisfies Record<keyof PortalConfig, KeySpec>,
    },
    stateRemovalPolicy: LEAF,
    basyx: {
      mapOf: {
        keys: {
          services: LEAF,
          dtrConnector: LEAF,
          profile: LEAF,
          stateRemovalPolicy: LEAF,
        } satisfies Record<keyof BasyxEntry, KeySpec>,
      },
    },
  } satisfies Record<keyof DeploymentYaml, KeySpec>,
};

const CONNECTOR_KEY_SPEC: KeySpec = {
  keys: {
    connectorId: LEAF,
    bpnl: LEAF,
    profile: LEAF,
    controlPlaneCpu: LEAF,
    controlPlaneMemoryLimitMiB: LEAF,
    dataPlaneCpu: LEAF,
    dataPlaneMemoryLimitMiB: LEAF,
    interactiveStateMachineIterationMillis: LEAF,
    backgroundStateMachineIterationMillis: LEAF,
    dataPlaneFlowLeaseMillis: LEAF,
    stateRemovalPolicy: LEAF,
    logLevel: LEAF,
  } satisfies Record<keyof ConnectorYaml, KeySpec>,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throws on the first key not allowed by spec: `<file>: unknown key '<dotted.path>'`. */
function rejectUnknownKeys(
  value: unknown,
  spec: KeySpec,
  file: string,
  path: string[] = [],
): void {
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const childSpec = spec.mapOf ?? spec.keys?.[key];
    if (childSpec === undefined) {
      throw new Error(`${file}: unknown key '${childPath.join(".")}'`);
    }
    rejectUnknownKeys(child, childSpec, file, childPath);
  }
}

// ─── Derived values ───────────────────────────────────────────────────────────

/** BaSyx entries with their BPNL, sorted by BPNL. */
export function basyxEntries(
  config: DeploymentConfig,
): (BasyxEntry & { bpnl: string })[] {
  return Object.entries(config.deployment.basyx ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([bpnl, entry]) => ({ ...entry, bpnl }));
}

/** CloudFormation stack name of a BPNL's BaSyx stack. */
export function basyxStackName(stackPrefix: string, bpnl: string): string {
  return `${stackPrefix}-BaSyx-${bpnl}`;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Loads and validates deployment configuration from YAML files at configPath.
 * Throws if required files or fields are missing.
 */
export function loadDeploymentConfig(configPath: string): DeploymentConfig {
  const deploymentPath = join(configPath, "deployment.yaml");
  if (!existsSync(deploymentPath)) {
    throw new Error(`deployment.yaml not found at ${deploymentPath}`);
  }

  const rawDeployment = yaml.load(
    readFileSync(deploymentPath, "utf-8"),
  ) as Partial<DeploymentYaml>;
  rejectUnknownKeys(rawDeployment, DEPLOYMENT_KEY_SPEC, "deployment.yaml");
  const deployment: DeploymentYaml = {
    profile: "development",
    vpcIpAddresses: "10.0.0.0/20",
    containerInsights: false,
    stateRemovalPolicy: "RETAIN",
    ...rawDeployment,
  } as DeploymentYaml;
  validateDeployment(deployment, deploymentPath);

  const connectorsDir = join(configPath, "connectors");
  const files = existsSync(connectorsDir)
    ? readdirSync(connectorsDir)
        .filter((f) => f.startsWith("connector-") && f.endsWith(".yaml"))
        .sort()
    : [];

  const connectors = files.map((file) => {
    const raw = yaml.load(
      readFileSync(join(connectorsDir, file), "utf-8"),
    ) as Partial<ConnectorYaml>;
    rejectUnknownKeys(raw, CONNECTOR_KEY_SPEC, `connectors/${file}`);
    const connector = {
      profile: "production",
      controlPlaneCpu: 256,
      controlPlaneMemoryLimitMiB: 1024,
      dataPlaneCpu: 256,
      dataPlaneMemoryLimitMiB: 512,
      interactiveStateMachineIterationMillis: 10000,
      backgroundStateMachineIterationMillis: 60000,
      dataPlaneFlowLeaseMillis: 10000,
      stateRemovalPolicy: deployment.stateRemovalPolicy,
      logLevel: deployment.logLevel,
      ...raw,
    } as ConnectorYaml;
    validateConnector(connector, file);
    if (connector.bpnl !== undefined) {
      validateBpnl(connector.bpnl, `connectors/${file}`, "bpnl");
    } else if (deployment.portal.bpnl === undefined) {
      throw new Error(
        `connectors/${file}: no BPNL. Set bpnl here or portal.bpnl in deployment.yaml.`,
      );
    }
    validateStateRemovalPolicy(
      connector.stateRemovalPolicy,
      `connectors/${file}`,
      "stateRemovalPolicy",
    );
    return connector;
  });

  validateBasyx(deployment, connectors);
  const basyx = Object.fromEntries(
    Object.entries(deployment.basyx ?? {}).map(([bpnl, entry]) => [
      bpnl,
      {
        dtrConnector: connectors.find(
          (c) => connectorBpnl(deployment, c) === bpnl,
        )!.connectorId,
        profile: deployment.profile,
        stateRemovalPolicy: deployment.stateRemovalPolicy,
        ...(entry as Partial<BasyxEntry>),
      } as BasyxEntry,
    ]),
  );

  return {
    deployment: { ...deployment, ...(deployment.basyx && { basyx }) },
    connectors,
  };
}

/** Loads pipeline.yaml from configPath and rejects unknown keys. */
export function loadPipelineConfig(configPath: string): PipelineYaml {
  const pipelinePath = join(configPath, "pipeline.yaml");
  if (!existsSync(pipelinePath)) {
    throw new Error(
      `pipeline.yaml not found at ${pipelinePath}. ` +
        `Provide --context config-path=<path>.`,
    );
  }
  const pipeline = yaml.load(
    readFileSync(pipelinePath, "utf-8"),
  ) as PipelineYaml;
  rejectUnknownKeys(pipeline, PIPELINE_KEY_SPEC, "pipeline.yaml");
  if (
    pipeline.configSource === "github" &&
    (!pipeline.configRepoName || !pipeline.connectionArn)
  ) {
    throw new Error(
      "pipeline.yaml: configSource github requires configRepoName and connectionArn",
    );
  }
  return pipeline;
}

function validateDeployment(data: DeploymentYaml, filePath: string): void {
  if (!isPlainObject(data.portal)) {
    throw new Error(`${filePath}: missing required field: portal`);
  }
  validateProfile(data.profile, filePath, "profile");
  const domainKeys = ["certificateArn", "domainName", "hostedZoneId"] as const;
  const setDomainKeys = domainKeys.filter((key) => data[key] !== undefined);
  if (setDomainKeys.length > 0 && setDomainKeys.length < domainKeys.length) {
    throw new Error(
      `${filePath}: a custom domain needs all of ${domainKeys.join(", ")}`,
    );
  }
  const environment: unknown = data.portal.environment;
  if (!Object.keys(PORTAL_ENVIRONMENTS).includes(String(environment))) {
    throw new Error(
      `${filePath}: portal.environment must be "beta" or "production", got "${String(environment)}"`,
    );
  }
  if (data.portal.bpnl !== undefined) {
    validateBpnl(data.portal.bpnl, filePath, "portal.bpnl");
  }
  validateLogLevel(data.logLevel, filePath);
  validateStateRemovalPolicy(
    data.stateRemovalPolicy,
    "deployment.yaml",
    "stateRemovalPolicy",
  );
}

function validateConnector(data: ConnectorYaml, fileName: string): void {
  const required: (keyof ConnectorYaml)[] = ["connectorId"];
  const missing = required.filter(
    (key) => data[key] === undefined || data[key] === null,
  );
  if (missing.length > 0) {
    throw new Error(
      `${fileName}: missing required fields: ${missing.join(", ")}`,
    );
  }
  validateConnectorId(data.connectorId);
  validateProfile(data.profile, `connectors/${fileName}`, "profile");
  validateLogLevel(data.logLevel, fileName);
}

/** Throws unless value is "development" or "production". */
function validateProfile(value: unknown, file: string, path: string): void {
  if (value !== "development" && value !== "production") {
    throw new Error(
      `${file}: ${path} must be "development" or "production", got "${String(value)}"`,
    );
  }
}

/** Throws unless logLevel is omitted or one of LOG_LEVELS. */
export function validateLogLevel(logLevel: unknown, source: string): void {
  if (logLevel !== undefined && !LOG_LEVELS.includes(logLevel as LogLevel)) {
    throw new Error(
      `${source}: logLevel must be one of ${LOG_LEVELS.join(", ")}, got "${String(logLevel)}"`,
    );
  }
}

/** Throws unless value is omitted, "RETAIN" or "DESTROY". */
function validateStateRemovalPolicy(
  value: unknown,
  file: string,
  path: string,
): void {
  if (
    value !== undefined &&
    !STATE_REMOVAL_POLICIES.includes(value as StateRemovalPolicy)
  ) {
    throw new Error(
      `${file}: ${path} must be "RETAIN" or "DESTROY", got "${String(value)}"`,
    );
  }
}

const BPNL_PATTERN = /^BPNL[0-9A-Z]{12}$/;

function validateBpnl(value: unknown, file: string, path: string): void {
  if (typeof value !== "string" || !BPNL_PATTERN.test(value)) {
    throw new Error(`${file}: ${path} '${String(value)}' is not a valid BPNL`);
  }
}

/** Validates the deployment.yaml basyx block against the loaded connectors. */
function validateBasyx(
  deployment: DeploymentYaml,
  connectors: ConnectorYaml[],
): void {
  const basyx: unknown = deployment.basyx;
  if (basyx === undefined || basyx === null) return;
  const file = "deployment.yaml";
  if (!isPlainObject(basyx)) {
    throw new Error(`${file}: basyx must be a map keyed by BPNL`);
  }
  const bpnlOf = (c: ConnectorYaml) => connectorBpnl(deployment, c);

  for (const [bpnl, raw] of Object.entries(basyx)) {
    const at = `basyx.${bpnl}`;
    if (!BPNL_PATTERN.test(bpnl)) {
      throw new Error(`${file}: basyx key '${bpnl}' is not a valid BPNL`);
    }
    if (!isPlainObject(raw)) {
      throw new Error(`${file}: ${at} must be a map`);
    }
    const entry = raw as Partial<BasyxEntry>;
    const services: unknown = entry.services;
    if (!Array.isArray(services) || services.length === 0) {
      throw new Error(`${file}: ${at}.services must be a non-empty list`);
    }
    for (const service of services) {
      if (!BASYX_SERVICES.includes(service as BasyxService)) {
        throw new Error(
          `${file}: ${at}.services: unknown service '${String(service)}' (allowed: ${BASYX_SERVICES.join(", ")})`,
        );
      }
    }
    if (!services.includes("dtr")) {
      throw new Error(`${file}: ${at}.services must include 'dtr'`);
    }
    if (entry.profile !== undefined) {
      validateProfile(entry.profile, file, `${at}.profile`);
    }
    validateStateRemovalPolicy(
      entry.stateRemovalPolicy,
      file,
      `${at}.stateRemovalPolicy`,
    );
    if (!connectors.some((c) => bpnlOf(c) === bpnl)) {
      throw new Error(
        `${file}: ${at}: no connector in this deployment has BPNL ${bpnl}`,
      );
    }
    if (entry.dtrConnector !== undefined) {
      const dtr = connectors.find((c) => c.connectorId === entry.dtrConnector);
      if (dtr === undefined) {
        throw new Error(
          `${file}: ${at}.dtrConnector '${String(entry.dtrConnector)}' does not exist`,
        );
      }
      if (bpnlOf(dtr) !== bpnl) {
        throw new Error(
          `${file}: ${at}.dtrConnector '${dtr.connectorId}' belongs to ${String(bpnlOf(dtr))}`,
        );
      }
    }
  }
}
