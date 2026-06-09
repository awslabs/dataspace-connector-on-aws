// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { RemovalPolicy } from "aws-cdk-lib";
import { ArnPrincipal, IPrincipal } from "aws-cdk-lib/aws-iam";

import {
  CONTROL_PLANE_PORT_MAPPING_DEFAULT,
  ControlPlanePortMapping,
  DATA_PLANE_PORT_MAPPING_DEFAULT,
  DataPlanePortMapping,
} from "./port-mappings";

export type DeploymentProfile = "development" | "production";

export const EDC_IAM_ENVIRONMENT_VARIABLE_KEYS = {
  TRUSTED_ISSUER: "edc.iam.trusted-issuer.issuer-1.id",
  DCP_STS_OAUTH_TOKEN_URL: "edc.iam.sts.oauth.token.url",
  DCP_STS_OAUTH_CLIENT_ID: "edc.iam.sts.oauth.client.id",
  DCP_STS_DIM_URL: "tx.edc.iam.sts.dim.url",
  PARTICIPANT_ID: "tractusx.edc.participant.bpn",
  DCP_ID: "edc.iam.issuer.id",
  DID_RESOLVER: "tx.edc.iam.iatp.bdrs.server.url",
};

export const EDC_SECRETS_MANAGER_ALIASES = {
  DCP_STS_OAUTH_CLIENT_SECRET_ALIAS: "edc.iam.sts.oauth.client.secret",
  TOKEN_SIGNER_PRIVATE_KEY: "edc.transfer.proxy.token.signer.privatekey",
  TOKEN_VERIFIER_PUBLIC_KEY: "edc.transfer.proxy.token.verifier.publickey",
};

// ─── Shared Infrastructure Config ─────────────────────────────────────────────

export interface SharedInfraConfig {
  readonly certificateArn?: string;
  readonly containerInsights: boolean;
  readonly controlPlanePortMapping: ControlPlanePortMapping;
  readonly dataPlanePortMapping: DataPlanePortMapping;
  readonly domainName?: string;
  readonly hostedZoneId?: string;
  readonly managementApiPrincipals: IPrincipal[];
  readonly observabilityApiPrincipals: IPrincipal[];
  readonly profile: DeploymentProfile;
  readonly vpcIpAddresses: string;
}

// ─── Per-Connector Config ─────────────────────────────────────────────────────

/**
 * connectorId constraints (must be compatible with all usage sites):
 * - Allowed characters: lowercase alphanumeric + hyphens [a-z0-9-]
 * - Length: 2–60 characters
 * - Cannot start or end with a hyphen
 *
 * Used in: ALB path patterns, URL rewrite regex, API Gateway paths,
 * Secrets Manager name prefix, CloudFormation stack name suffix,
 * DynamoDB table prefix (future), ECS runtime ID.
 */
export function validateConnectorId(connectorId: string): void {
  if (!/^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$/.test(connectorId)) {
    throw new Error(
      `Invalid connectorId "${connectorId}". Must be 2-60 chars, lowercase alphanumeric + hyphens, cannot start/end with hyphen.`,
    );
  }
}

export interface ConnectorConfig {
  readonly connectorId: string;
  readonly controlPlaneCpu: number;
  readonly controlPlaneMemoryLimitMiB: number;
  readonly dataPlaneCpu: number;
  readonly dataPlaneMemoryLimitMiB: number;
  readonly edcIam: { [key: string]: string };
  readonly edcStateRemovalPolicy: RemovalPolicy;
  readonly profile?: DeploymentProfile;
  readonly stateMachineIterationMillis: string;
}

// ─── Deployment Config (combined) ─────────────────────────────────────────────

export interface DeploymentConfig {
  readonly sharedInfra: SharedInfraConfig;
  readonly connectors: ConnectorConfig[];
}

// ─── Configuration Values ─────────────────────────────────────────────────────

/**
 * Enter EDC configuration values obtained from the Cofinity-X Portal below.
 *
 * Each connector requires its own identity credentials from the portal's
 * "Configure Your Connector" dialog: https://portal.beta.cofinity-x.com/connectorManagement
 * Copy-paste the values directly from the portal into each connector's edcIam section.
 */

export const DEPLOYMENT_CONFIG: DeploymentConfig = {
  sharedInfra: {
    // certificateArn: "arn:aws:acm:us-east-1:<account-id>:certificate/<certificate-id>",
    // domainName: "edc.example.com",
    // hostedZoneId: "Z0123456789ABCDEFGHIJ",
    containerInsights: true,
    controlPlanePortMapping: CONTROL_PLANE_PORT_MAPPING_DEFAULT,
    dataPlanePortMapping: DATA_PLANE_PORT_MAPPING_DEFAULT,
    managementApiPrincipals: [
      // new ArnPrincipal("arn:aws:iam::<account-id>:role/<role-name>"),
    ],
    observabilityApiPrincipals: [
      // new ArnPrincipal("arn:aws:iam::<account-id>:role/<role-name>"),
    ],
    profile: "development",
    vpcIpAddresses: "10.0.0.0/20",
  },
  connectors: [
    {
      connectorId: "default",
      controlPlaneCpu: 256,
      controlPlaneMemoryLimitMiB: 1024,
      dataPlaneCpu: 256,
      dataPlaneMemoryLimitMiB: 512,
      edcIam: {
        [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.TRUSTED_ISSUER]: "",
        [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DCP_STS_OAUTH_TOKEN_URL]: "",
        [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DCP_STS_OAUTH_CLIENT_ID]: "",
        [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DCP_STS_DIM_URL]: "",
        [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.PARTICIPANT_ID]: "",
        [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DCP_ID]: "",
        [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DID_RESOLVER]: "",
      },
      edcStateRemovalPolicy: RemovalPolicy.DESTROY,
      profile: "development", // Optional, overrides shared profile if set
      stateMachineIterationMillis: "10000",
    },
  ],
};
