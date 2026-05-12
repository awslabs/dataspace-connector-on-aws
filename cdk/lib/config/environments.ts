// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { RemovalPolicy } from "aws-cdk-lib";
import { ArnPrincipal } from "aws-cdk-lib/aws-iam";
import { DataspaceConnectorStackProps } from "../dataspace-connector-stack";

export type DeploymentProfile = "development" | "production";
export type Architecture = "x86_64" | "arm64";

import {
  CONTROL_PLANE_PORT_MAPPING_DEFAULT,
  DATA_PLANE_PORT_MAPPING_DEFAULT,
} from "./port-mappings";

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

/**
 * Enter EDC configuration values obtained from the Cofinity-X Portal below.
 *
 * The keys match the labels shown in the portal's "Configure Your Connector" dialog under https://portal.beta.cofinity-x.com/connectorManagement.
 * Copy-paste the values directly from the portal into this configuration.
 */

const edcIam = {
  [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.TRUSTED_ISSUER]: "",
  [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DCP_STS_OAUTH_TOKEN_URL]: "",
  [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DCP_STS_OAUTH_CLIENT_ID]: "",
  [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DCP_STS_DIM_URL]: "",
  [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.PARTICIPANT_ID]: "",
  [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DCP_ID]: "",
  [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DID_RESOLVER]: "",
};

/**
 * Enter CDK configuration values for AWS resources below.
 *
 * Make sure to adjust CPU and memory as per your needs and set the APIs' IAM principals.
 */

export const DataspaceConnectorStackConfig: DataspaceConnectorStackProps = {
  // Optional: Custom domain for EDC API endpoints (see README for details)
  // certificateArn: "arn:aws:acm:us-east-1:<account-id>:certificate/<certificate-id>",
  // domainName: "edc.example.com",
  // hostedZoneId: "Z0123456789ABCDEFGHIJ",
  architecture: "arm64",
  controlPlaneCpu: 256,
  controlPlaneMemoryLimitMiB: 1024,
  controlPlanePolicyMonitorIteration: "600000", // Run every 10 minutes
  controlPlanePortMapping: CONTROL_PLANE_PORT_MAPPING_DEFAULT,
  dataPlaneCpu: 256,
  dataPlaneMemoryLimitMiB: 512,
  dataPlanePortMapping: DATA_PLANE_PORT_MAPPING_DEFAULT,
  edcIam: edcIam,
  edcStateRemovalPolicy: RemovalPolicy.DESTROY,
  managementApiAuthKey: "",
  managementApiPrincipals: [
    // new ArnPrincipal("arn:aws:iam::<account-id>:role/<role-name>"),
  ],
  observabilityApiPrincipals: [
    // new ArnPrincipal("arn:aws:iam::<account-id>:role/<role-name>"),
  ],
  profile: "development",
  vpcIpAddresses: "10.0.10.0/24",
};
