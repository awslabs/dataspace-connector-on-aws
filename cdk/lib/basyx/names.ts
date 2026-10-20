// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  BasyxService,
  connectorPriority,
  deriveSecretPrefix,
} from "../config/config";

/** Container port and the shared ALB's data-plane read listener port. */
export const BASYX_PORT = 5004;
/** First path segment of every BaSyx route on the ALB and the management API. */
export const BASYX_PATH_PREFIX = "basyx";
/** Header that carries the Cognito token through the IAM-authorized management API. */
export const BASYX_TOKEN_HEADER = "X-BaSyx-Authorization";

export const RESOURCE_SERVER_ID = "dataspace-connector-basyx";
export const READ_SCOPE_NAME = "read";
export const READ_SCOPE = `${RESOURCE_SERVER_ID}/${READ_SCOPE_NAME}`;
export const WRITE_SCOPE_NAME = "write";

/** Short name of each service: its path segment, container name and database. */
export const SERVICE_NAMES = {
  dtr: "dtr",
  submodelRepository: "smrepo",
} as const;

const COGNITO_DOMAIN_PREFIX_MAX = 63;
const COGNITO_FORBIDDEN_WORDS = ["aws", "amazon", "cognito"];

/**
 * Context path a service serves under. The ALB can't rewrite paths, so the
 * BPNL and service are part of it; the DTR keeps its API version suffix.
 */
export function basyxContextPath(bpnl: string, service: BasyxService): string {
  const base = `/${BASYX_PATH_PREFIX}/${bpnl}/${SERVICE_NAMES[service]}`;
  return service === "dtr" ? `${base}/api/v3` : base;
}

/** ALB listener rule priority of a BPNL's service, from the connector priority hash. */
export function basyxPriority(bpnl: string, service: BasyxService): number {
  return connectorPriority(`${BASYX_PATH_PREFIX}/${bpnl}/${service}`);
}

/**
 * Cognito domain prefix and Aurora cluster identifier of a BPNL. Both share
 * the 63-character limit checked by validateCognitoDomainPrefix.
 */
export function cognitoDomainPrefix(
  deploymentName: string,
  bpnl: string,
): string {
  return `${deploymentName.toLowerCase()}-basyx-${bpnl.toLowerCase()}`;
}

/**
 * Throws if the Cognito domain prefix for this deployment and BPNL breaks a
 * Cognito naming rule (at most 63 characters, none of aws/amazon/cognito).
 */
export function validateCognitoDomainPrefix(
  deploymentName: string,
  bpnl: string,
): void {
  const prefix = cognitoDomainPrefix(deploymentName, bpnl);
  if (prefix.length > COGNITO_DOMAIN_PREFIX_MAX) {
    throw new Error(
      `basyx.${bpnl}: Cognito domain prefix "${prefix}" is ${prefix.length} characters (max ${COGNITO_DOMAIN_PREFIX_MAX}); use a deploymentName of at most ${COGNITO_DOMAIN_PREFIX_MAX - (prefix.length - deploymentName.length)} characters`,
    );
  }
  const word = COGNITO_FORBIDDEN_WORDS.find((w) => prefix.includes(w));
  if (word) {
    throw new Error(
      `basyx.${bpnl}: Cognito domain prefix "${prefix}" contains the reserved word "${word}"; choose a deploymentName without it`,
    );
  }
}

export function cognitoTokenUrl(domainPrefix: string, region: string): string {
  return `https://${domainPrefix}.auth.${region}.amazoncognito.com/oauth2/token`;
}

/** DTR URL the dtrConnector's data plane reads from, on the shared ALB. */
export function dtrUrl(albDnsName: string, bpnl: string): string {
  return `http://${albDnsName}:${BASYX_PORT}${basyxContextPath(bpnl, "dtr")}`;
}

/**
 * Secrets Manager name (EDC vault alias) of the data-plane client secret. It
 * sits under the dtrConnector's secret prefix, which its data plane can read.
 */
export function basyxClientSecretAlias(
  deploymentName: string,
  dtrConnectorId: string,
): string {
  return `${deriveSecretPrefix(deploymentName, dtrConnectorId)}basyx.dtr.oauth.client.secret`;
}

/** Secrets Manager name of the provider's writer client secret. */
export function basyxWriterSecretName(
  deploymentName: string,
  bpnl: string,
): string {
  return `${deploymentName}/basyx/${bpnl}/writer-client-secret`;
}
