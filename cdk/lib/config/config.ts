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
export const DEFAULT_STATE_REMOVAL_POLICY: StateRemovalPolicy = "RETAIN";

export const BASYX_SERVICES = ["dtr", "submodelRepository"] as const;
export type BasyxService = (typeof BASYX_SERVICES)[number];

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
  /** EDC log level for all connectors; a connector may override it. Unset keeps the Tractus-X default. */
  readonly logLevel?: LogLevel;
  readonly portal: PortalConfig;
  /** Default removal policy for stored state; connectors and BaSyx entries may override it. Default RETAIN. */
  readonly stateRemovalPolicy?: StateRemovalPolicy;
  /** Eclipse BaSyx (Digital Twin Registry + Submodel Repository) per BPNL, keyed by BPNL. */
  readonly basyx?: Record<string, BasyxEntry>;
}

/** One BaSyx deployment for one BPNL. */
export interface BasyxEntry {
  readonly services: BasyxService[];
  /** Connector that offers the DTR asset. Default: the BPNL's first connector (file name order). */
  readonly dtrConnector?: string;
  /** Overrides the deployment.yaml profile for this BaSyx stack. */
  readonly profile?: DeploymentProfile;
  /** Overrides the deployment.yaml stateRemovalPolicy for this BaSyx database. */
  readonly stateRemovalPolicy?: StateRemovalPolicy;
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
  /**
   * Data-plane flow-lease heartbeat interval (ms) for in-flight (STARTED) PULL flows. Each open flow
   * re-stamps its ownership this often (a DynamoDB write), and after value × 5 an unrefreshed flow is
   * considered abandoned so another data-plane runtime may take it over. Lower = faster multi-runtime
   * failover but higher DynamoDB write cost; raise it to cut cost on single-runtime deployments. Set
   * independently of the poll intervals. Default "10000" (abandon window 50s); EDC's own default is 500ms.
   */
  readonly dataPlaneFlowLeaseMillis?: string;
  /** Overrides the deployment.yaml stateRemovalPolicy for this connector's DynamoDB table and S3 bucket. */
  readonly stateRemovalPolicy?: StateRemovalPolicy;
  /** Cofinity-X portal technical user (service account) ID, authored by the operator. */
  readonly serviceAccountId: string;
  /** EDC log level for this connector, overriding the deployment.yaml logLevel. */
  readonly logLevel?: LogLevel;
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

const IDENTITY_KEY_SPEC: KeySpec = {
  keys: {
    trustedIssuer: LEAF,
    stsOauthTokenUrl: LEAF,
    stsDimUrl: LEAF,
    participantId: LEAF,
    dcpId: LEAF,
    didResolver: LEAF,
  } satisfies Record<keyof PortalIdentity, KeySpec>,
};

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
        identity: IDENTITY_KEY_SPEC,
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
    profile: LEAF,
    controlPlaneCpu: LEAF,
    controlPlaneMemoryLimitMiB: LEAF,
    dataPlaneCpu: LEAF,
    dataPlaneMemoryLimitMiB: LEAF,
    interactiveStateMachineIterationMillis: LEAF,
    backgroundStateMachineIterationMillis: LEAF,
    dataPlaneFlowLeaseMillis: LEAF,
    stateRemovalPolicy: LEAF,
    serviceAccountId: LEAF,
    logLevel: LEAF,
    portal: {
      keys: {
        identity: IDENTITY_KEY_SPEC,
      } satisfies Record<keyof ConnectorPortalOverride, KeySpec>,
    },
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

/** Resolves a removal policy: the override, else the deployment value, else RETAIN. */
export function resolveStateRemovalPolicy(
  deployment: DeploymentYaml,
  override?: StateRemovalPolicy,
): StateRemovalPolicy {
  return (
    override ?? deployment.stateRemovalPolicy ?? DEFAULT_STATE_REMOVAL_POLICY
  );
}

/** A BaSyx entry with its resolved DTR connector. */
export interface ResolvedBasyx {
  readonly bpnl: string;
  readonly entry: BasyxEntry;
  readonly dtrConnectorId: string;
}

/**
 * BaSyx entries, sorted by BPNL. dtrConnectorId defaults to the BPNL's
 * first connector in file name order; validateBasyx guarantees one exists.
 */
export function basyxEntries(config: DeploymentConfig): ResolvedBasyx[] {
  const { deployment, connectors } = config;
  return Object.entries(deployment.basyx ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([bpnl, entry]) => {
      const dtrConnectorId =
        entry.dtrConnector ??
        connectors.find(
          (c) => resolveConnectorIdentity(deployment, c).participantId === bpnl,
        )!.connectorId;
      return { bpnl, entry, dtrConnectorId };
    });
}

/** CloudFormation stack name of a BPNL's BaSyx stack. */
export function basyxStackName(stackPrefix: string, bpnl: string): string {
  return `${stackPrefix}-BaSyx-${bpnl}`;
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
  rejectUnknownKeys(deployment, DEPLOYMENT_KEY_SPEC, "deployment.yaml");
  validateDeployment(deployment, deploymentPath);

  const connectorsDir = join(configPath, "connectors");
  const files = existsSync(connectorsDir)
    ? readdirSync(connectorsDir)
        .filter((f) => f.startsWith("connector-") && f.endsWith(".yaml"))
        .sort()
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
    rejectUnknownKeys(connector, CONNECTOR_KEY_SPEC, `connectors/${file}`);
    validateConnector(connector, file);
    validateStateRemovalPolicy(
      connector.stateRemovalPolicy,
      `connectors/${file}`,
      "stateRemovalPolicy",
    );
    return connector;
  });

  validateBasyx(deployment, connectors);

  return { deployment, connectors };
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
  const pipeline = yaml.load(readFileSync(pipelinePath, "utf-8"));
  rejectUnknownKeys(pipeline, PIPELINE_KEY_SPEC, "pipeline.yaml");
  return pipeline as PipelineYaml;
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
  validateProfile(data.profile, filePath, "profile");
  if (!data.portal.environment) {
    throw new Error(`${filePath}: portal section requires 'environment'`);
  }
  validateLogLevel(data.logLevel, filePath);
  validateStateRemovalPolicy(
    data.stateRemovalPolicy,
    "deployment.yaml",
    "stateRemovalPolicy",
  );
}

function validateConnector(data: ConnectorYaml, fileName: string): void {
  const required: (keyof ConnectorYaml)[] = [
    "connectorId",
    "controlPlaneCpu",
    "controlPlaneMemoryLimitMiB",
    "dataPlaneCpu",
    "dataPlaneMemoryLimitMiB",
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
  if (data.profile !== undefined) {
    validateProfile(data.profile, `connectors/${fileName}`, "profile");
  }
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
  const bpnlOf = (c: ConnectorYaml) =>
    resolveConnectorIdentity(deployment, c).participantId;

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
        `${file}: ${at}: no connector in this deployment has participantId ${bpnl}`,
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
