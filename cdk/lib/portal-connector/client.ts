// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cofinity-X portal API client used by the PortalConnector custom resource.
 * Imports only `fetch` and the Secrets Manager SDK, both provided by the
 * Lambda Node.js runtime, so the handler needs no bundling.
 */

import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

// ─── Portal environments ──────────────────────────────────────────────────────

export interface PortalEnvironmentSettings {
  readonly backend: string;
  readonly keycloak: string;
  /** Host of the portal's did:web documents. */
  readonly didHost: string;
  readonly trustedIssuer: string;
  readonly didResolver: string;
}

/** Wallet (DIM) service URL, the same for every portal environment. */
export const STS_DIM_URL =
  "https://dis-integration-service-prod.eu10.div.cloud.sap/api/v2.0.0/dcp/catena-x-portal";

export const PORTAL_ENVIRONMENTS = {
  beta: {
    backend: "https://portal-backend.beta.cofinity-x.com/api/administration",
    keycloak:
      "https://centralidp.beta.cofinity-x.com/auth/realms/CX-Central/protocol/openid-connect/token",
    didHost: "portal-backend.beta.cofinity-x.com",
    trustedIssuer:
      "did:web:portal-backend.beta.cofinity-x.com:api:administration:staticdata:did:BPNLCOFINITYEZFA",
    didResolver: "https://bdrs.beta.cofinity-x.com/api/directory",
  },
  production: {
    backend: "https://portal-backend.svc.cofinity-x.com/api/administration",
    keycloak:
      "https://centralidp.svc.cofinity-x.com/auth/realms/CX-Central/protocol/openid-connect/token",
    didHost: "portal-backend.svc.cofinity-x.com",
    trustedIssuer:
      "did:web:portal-backend.svc.cofinity-x.com:api:administration:staticdata:did:BPNLCOFINITYEZFA",
    didResolver: "https://bdrs.svc.cofinity-x.com/api/directory",
  },
} as const satisfies Record<string, PortalEnvironmentSettings>;

export type PortalEnvironment = keyof typeof PORTAL_ENVIRONMENTS;

/** Portal role of the per-connector technical user (wallet access). */
export const IDENTITY_WALLET_MANAGEMENT_ROLE_ID =
  "607818be-4978-41f4-bf63-fa8d2de51157";

/** The company DID the portal hosts for a BPNL. */
export function companyDid(environment: PortalEnvironment, bpnl: string) {
  return `did:web:${PORTAL_ENVIRONMENTS[environment].didHost}:api:administration:staticdata:did:${bpnl}`;
}

/** The HTTPS URL a did:web DID resolves to. */
export function didDocumentUrl(did: string): string {
  const [host, ...path] = did.replace(/^did:web:/, "").split(":");
  return `https://${host}/${path.join("/")}/did.json`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PortalAdminCredentials {
  clientId: string;
  clientSecret: string;
}

export interface TechnicalUser {
  serviceAccountId: string;
  /** Null while the user is PENDING. */
  clientId: string | null;
  secret: string | null;
  status: string;
  authenticationServiceUrl: string;
}

export interface ConnectorRegistration {
  id: string;
  name: string;
  connectorUrl: string;
  technicalUser?: { id: string } | null;
}

/** A portal response other than 2xx, with the error code from its body. */
export class PortalError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    context: string,
  ) {
    super(`${context}: ${status} ${body}`);
  }
}

// ─── Portal API client ────────────────────────────────────────────────────────

export class PortalClient {
  private token?: { value: string; expiresAt: number };
  private readonly settings: PortalEnvironmentSettings;

  constructor(
    environment: PortalEnvironment,
    private readonly credentials: PortalAdminCredentials,
  ) {
    this.settings = PORTAL_ENVIRONMENTS[environment];
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) {
      return this.token.value;
    }
    const response = await fetch(this.settings.keycloak, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        grant_type: "client_credentials",
      }),
    });
    if (!response.ok) {
      throw new PortalError(
        response.status,
        await response.text(),
        "Portal authentication failed",
      );
    }
    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.token = {
      value: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };
    return this.token.value;
  }

  /** The BPN of the company the admin credentials belong to. */
  async companyBpn(): Promise<string> {
    const payload = (await this.getToken()).split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString()).bpn;
  }

  /** An authenticated call; throws PortalError on a non-2xx response. */
  private async call(
    method: string,
    path: string,
    context: string,
    body?: URLSearchParams | object,
  ): Promise<Response> {
    const isForm = body instanceof URLSearchParams;
    const response = await fetch(`${this.settings.backend}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.getToken()}`,
        "Content-Type": isForm
          ? "application/x-www-form-urlencoded"
          : "application/json",
      },
      body:
        body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new PortalError(response.status, await response.text(), context);
    }
    return response;
  }

  /** Creates an Identity Wallet Management technical user; returns its id. */
  async createTechnicalUser(
    name: string,
    description: string,
  ): Promise<string> {
    const response = await this.call(
      "POST",
      "/serviceaccount/owncompany/serviceaccounts",
      `Failed to create technical user "${name}"`,
      {
        name,
        description,
        authenticationType: "SECRET",
        roleIds: [IDENTITY_WALLET_MANAGEMENT_ROLE_ID],
      },
    );
    const created = (await response.json()) as { serviceAccountId: string }[];
    return created[0].serviceAccountId;
  }

  async getTechnicalUser(serviceAccountId: string): Promise<TechnicalUser> {
    const response = await this.call(
      "GET",
      `/serviceaccount/owncompany/serviceaccounts/${serviceAccountId}`,
      `Failed to read technical user ${serviceAccountId}`,
    );
    return (await response.json()) as TechnicalUser;
  }

  /** Registers a connector linked to a technical user; returns the registration id. */
  async registerConnector(
    name: string,
    connectorUrl: string,
    technicalUserId: string,
  ): Promise<string> {
    // [FromForm] endpoint: form fields with these PascalCase names.
    const response = await this.call(
      "POST",
      "/connectors",
      `Failed to register connector "${name}"`,
      new URLSearchParams({
        Name: name,
        ConnectorUrl: connectorUrl,
        Location: "DE",
        TechnicalUserId: technicalUserId,
      }),
    );
    const result = (await response.json()) as string | { id: string };
    return typeof result === "string" ? result : result.id;
  }

  async listConnectors(): Promise<ConnectorRegistration[]> {
    const connectors: ConnectorRegistration[] = [];
    for (let page = 0, pages = 1; page < pages; page++) {
      const response = await this.call(
        "GET",
        `/connectors?page=${page}&size=15`,
        "Failed to list connectors",
      );
      const data = (await response.json()) as {
        meta: { totalPages: number };
        content: ConnectorRegistration[];
      };
      pages = data.meta.totalPages;
      connectors.push(...data.content);
    }
    return connectors;
  }

  async updateConnectorUrl(id: string, connectorUrl: string): Promise<void> {
    await this.call(
      "PUT",
      `/connectors/${id}/connectorUrl`,
      `Failed to update connector ${id}`,
      { connectorUrl },
    );
  }

  /** Deletes a connector and its linked technical user. */
  async deleteConnector(id: string): Promise<void> {
    await this.call(
      "DELETE",
      `/connectors/${id}?deleteServiceAccount=true`,
      `Failed to delete connector ${id}`,
    );
  }
}

// ─── Secrets Manager ──────────────────────────────────────────────────────────

const secretsManager = new SecretsManagerClient({});

export async function readAdminCredentials(
  secretId: string,
): Promise<PortalAdminCredentials> {
  const result = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const parsed = JSON.parse(result.SecretString ?? "{}");
  if (!parsed.clientId || !parsed.clientSecret) {
    throw new Error(
      `Secret ${secretId} must hold JSON with "clientId" and "clientSecret"`,
    );
  }
  return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
}

export async function writeSecret(secretId: string, value: string) {
  await secretsManager.send(
    new PutSecretValueCommand({ SecretId: secretId, SecretString: value }),
  );
}
