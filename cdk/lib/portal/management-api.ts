// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal client for one connector's EDC Management API behind API Gateway
 * (AWS_IAM auth). Requests are SigV4-signed with the caller's IAM credentials.
 */

import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Sha256 } from "@smithy/core/checksum";
import { SignatureV4 } from "@smithy/signature-v4";

export interface ManagementResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Throws on any status other than 2xx and the ones listed in `allow`. */
export type ManagementRequest = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  allow?: number[],
) => Promise<ManagementResponse>;

/**
 * Returns a request function for `<baseUrl><connectorId>/v3<path>`.
 * baseUrl is the management API URL (SharedInfra `ManagementApiUrl` output or
 * `https://<domainName>/management/`).
 */
export function managementApi(
  baseUrl: string,
  connectorId: string,
  region: string,
  signer = new SignatureV4({
    credentials: defaultProvider(),
    region,
    service: "execute-api",
    sha256: Sha256,
  }),
): ManagementRequest {
  const base = new URL(
    `${baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`}${connectorId}/v3`,
  );

  return async (method, path, body, allow = []) => {
    const url = new URL(`${base.pathname}${path}`, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const signed = await signer.sign({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query: {},
      headers: {
        host: url.host,
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      body: payload,
    });

    const res = await fetch(url, {
      method,
      headers: signed.headers,
      body: payload,
    });
    const text = await res.text();
    if (!res.ok && !allow.includes(res.status)) {
      throw new Error(
        `${method} ${url.pathname} returned ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };
}
