// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

import { RemovalPolicy } from "aws-cdk-lib";
import { ArnPrincipal } from "aws-cdk-lib/aws-iam";
import * as yaml from "js-yaml";

import {
  ConnectorConfig,
  DeploymentConfig,
  EDC_IAM_ENVIRONMENT_VARIABLE_KEYS,
  SharedInfraConfig,
} from "./environments";

import {
  CONTROL_PLANE_PORT_MAPPING_DEFAULT,
  DATA_PLANE_PORT_MAPPING_DEFAULT,
} from "./port-mappings";

import { ConnectorYaml, DeploymentYaml } from "./schemas";

/**
 * Attempts to load deployment configuration from YAML files.
 * Returns undefined if the config path doesn't exist, allowing
 * fallback to environments.ts for local deploys.
 */
export function loadConfigFromYaml(
  configPath: string,
): DeploymentConfig | undefined {
  const deploymentPath = join(configPath, "deployment.yaml");
  if (!existsSync(deploymentPath)) return undefined;

  const deployment = yaml.load(
    readFileSync(deploymentPath, "utf-8"),
  ) as DeploymentYaml;
  validateDeploymentYaml(deployment, deploymentPath);

  const connectorsDir = join(configPath, "connectors");
  const connectorFiles = existsSync(connectorsDir)
    ? readdirSync(connectorsDir).filter(
        (f) => f.startsWith("connector-") && f.endsWith(".yaml"),
      )
    : [];

  if (connectorFiles.length === 0) {
    throw new Error(
      `No connector YAML files found in ${connectorsDir}. Add at least one connector-*.yaml file.`,
    );
  }

  const connectors: ConnectorConfig[] = connectorFiles.map((file) => {
    const raw = yaml.load(
      readFileSync(join(connectorsDir, file), "utf-8"),
    ) as ConnectorYaml;
    validateConnectorYaml(raw, file);
    return mapConnectorYaml(raw);
  });

  const sharedInfra: SharedInfraConfig = {
    certificateArn: deployment.certificateArn,
    containerInsights: deployment.containerInsights,
    controlPlanePortMapping: CONTROL_PLANE_PORT_MAPPING_DEFAULT,
    dataPlanePortMapping: DATA_PLANE_PORT_MAPPING_DEFAULT,
    domainName: deployment.domainName,
    hostedZoneId: deployment.hostedZoneId,
    managementApiPrincipals: (deployment.managementApiPrincipals ?? []).map(
      (arn) => new ArnPrincipal(arn),
    ),
    observabilityApiPrincipals: (
      deployment.observabilityApiPrincipals ?? []
    ).map((arn) => new ArnPrincipal(arn)),
    profile: deployment.profile,
    vpcIpAddresses: deployment.vpcIpAddresses,
  };

  return { sharedInfra, connectors };
}

function mapConnectorYaml(raw: ConnectorYaml): ConnectorConfig {
  return {
    connectorId: raw.connectorId,
    controlPlaneCpu: raw.controlPlaneCpu,
    controlPlaneMemoryLimitMiB: raw.controlPlaneMemoryLimitMiB,
    dataPlaneCpu: raw.dataPlaneCpu,
    dataPlaneMemoryLimitMiB: raw.dataPlaneMemoryLimitMiB,
    edcIam: {
      [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.TRUSTED_ISSUER]:
        raw.edcIam.trustedIssuer,
      [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DCP_STS_OAUTH_TOKEN_URL]:
        raw.edcIam.stsOauthTokenUrl,
      [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DCP_STS_OAUTH_CLIENT_ID]:
        raw.edcIam.stsOauthClientId,
      [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DCP_STS_DIM_URL]: raw.edcIam.stsDimUrl,
      [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.PARTICIPANT_ID]:
        raw.edcIam.participantId,
      [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DCP_ID]: raw.edcIam.dcpId,
      [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DID_RESOLVER]: raw.edcIam.didResolver,
    },
    edcStateRemovalPolicy:
      raw.edcStateRemovalPolicy === "RETAIN"
        ? RemovalPolicy.RETAIN
        : RemovalPolicy.DESTROY,
    profile: raw.profile,
    stateMachineIterationMillis: raw.stateMachineIterationMillis,
  };
}

function validateDeploymentYaml(
  data: DeploymentYaml,
  filePath: string,
): void {
  const required: (keyof DeploymentYaml)[] = [
    "profile",
    "vpcIpAddresses",
    "containerInsights",
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
}

function validateConnectorYaml(data: ConnectorYaml, fileName: string): void {
  const required: (keyof ConnectorYaml)[] = [
    "connectorId",
    "controlPlaneCpu",
    "controlPlaneMemoryLimitMiB",
    "dataPlaneCpu",
    "dataPlaneMemoryLimitMiB",
    "stateMachineIterationMillis",
    "edcStateRemovalPolicy",
    "edcIam",
  ];
  const missing = required.filter(
    (key) => data[key] === undefined || data[key] === null,
  );
  if (missing.length > 0) {
    throw new Error(
      `${fileName}: missing required fields: ${missing.join(", ")}`,
    );
  }
  if (!data.edcIam || typeof data.edcIam !== "object") {
    throw new Error(`${fileName}: edcIam must be an object`);
  }
  const requiredIam = [
    "trustedIssuer",
    "stsOauthTokenUrl",
    "stsOauthClientId",
    "stsDimUrl",
    "participantId",
    "dcpId",
    "didResolver",
  ];
  const missingIam = requiredIam.filter(
    (key) =>
      !(key in data.edcIam) ||
      data.edcIam[key as keyof typeof data.edcIam] === undefined,
  );
  if (missingIam.length > 0) {
    throw new Error(
      `${fileName}: edcIam missing required fields: ${missingIam.join(", ")}`,
    );
  }
}
