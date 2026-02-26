// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { RemovalPolicy } from "aws-cdk-lib";
import { ArnPrincipal } from "aws-cdk-lib/aws-iam";
import { DataspaceConnectorStackProps } from "../dataspace-connector-stack";

import {
  CONTROL_PLANE_PORT_MAPPING_DEFAULT,
  DATA_PLANE_PORT_MAPPING_DEFAULT,
} from "./port-mappings";

export const EDC_IAM_ENVIRONMENT_VARIABLE_KEYS = {
  DID_RESOLVER: "tx.edc.iam.iatp.bdrs.server.url",
  DIM_URL: "tx.edc.iam.sts.dim.url",
  IATP_ID: "edc.iam.issuer.id",
  OAUTH_CLIENT_ID: "edc.iam.sts.oauth.client.id",
  OAUTH_TOKEN_URL: "edc.iam.sts.oauth.token.url",
  PARTICIPANT_ID: "edc.participant.id",
  TRUSTED_ISSUER_ID: "edc.iam.trusted-issuer.issuer-1.id",

  OAUTH_CLIENT_SECRET: "edc.iam.sts.oauth.client.secret",
};

/**
 * Enter EDC configuration values obtained from Cofinity-X Portal below.
 *
 * This includes the client ID of the technical user the deployed EDC should use.
 */

const edcIam = {
  [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DID_RESOLVER]: "",
  [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.DIM_URL]: "",
  [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.IATP_ID]: "",
  [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.OAUTH_CLIENT_ID]: "",
  [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.OAUTH_TOKEN_URL]: "",
  [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.PARTICIPANT_ID]: "",
  [EDC_IAM_ENVIRONMENT_VARIABLE_KEYS.TRUSTED_ISSUER_ID]: "",
};

/**
 * Enter CDK configuration values for AWS resources below.
 *
 * Make sure to adjust CPU and memory as per your needs and set the APIs' IAM principals.
 */

export const DataspaceConnectorStackConfig: DataspaceConnectorStackProps = {
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
  vpcIpAddresses: "10.0.10.0/24",
};
