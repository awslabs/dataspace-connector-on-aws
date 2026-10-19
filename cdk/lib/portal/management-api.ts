// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal client for one connector's EDC Management API behind API Gateway
 * (AWS_IAM auth). Requests are SigV4-signed with the caller's IAM credentials.
 */

import { createHash, createHmac, Hash, Hmac } from "crypto";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";

type SourceData = string | ArrayBuffer | ArrayBufferView;

function toBytes(data: SourceData): string | Uint8Array {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** SHA-256 / HMAC-SHA256 over node:crypto, in the shape SignatureV4 expects. */
export class NodeSha256 {
  private hash: Hash | Hmac;
  private readonly secret?: string | Uint8Array;

  constructor(secret?: SourceData) {
    this.secret = secret === undefined ? undefined : toBytes(secret);
    this.hash = this.create();
  }

  update(data: SourceData): void {
    this.hash.update(toBytes(data));
  }

  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }

  reset(): void {
    this.hash = this.create();
  }

  private create(): Hash | Hmac {
    return this.secret === undefined
      ? createHash("sha256")
      : createHmac("sha256", this.secret);
  }
}

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
    sha256: NodeSha256,
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
