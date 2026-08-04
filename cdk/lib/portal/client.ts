// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared client for Cofinity-X Portal API interactions and Secrets Manager access.
 * Used by both provision.ts (pre-synth) and finalize.ts (post-deploy).
 *
 * The portal's connector registry is the source of truth for connector state —
 * DSCA persists no state of its own. Every operation is an idempotent read or
 * write against the portal or Secrets Manager.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

// ─── Portal Environment Configuration ─────────────────────────────────────────

const PORTAL_URLS = {
  beta: {
    backend: "https://portal-backend.beta.cofinity-x.com/api/administration",
    keycloak:
      "https://centralidp.beta.cofinity-x.com/auth/realms/CX-Central/protocol/openid-connect/token",
  },
  production: {
    backend: "https://portal-backend.svc.cofinity-x.com/api/administration",
    keycloak:
      "https://centralidp.svc.cofinity-x.com/auth/realms/CX-Central/protocol/openid-connect/token",
  },
} as const;

export type PortalEnvironment = keyof typeof PORTAL_URLS;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PortalAdminCredentials {
  clientId: string;
  clientSecret: string;
}

export interface TechUserDetails {
  serviceAccountId: string;
  clientId: string;
  secret: string;
  name: string;
  status: string;
  authenticationServiceUrl: string;
  connector: { id: string; name: string } | null;
}

export interface ConnectorRegistration {
  id: string;
  name: string;
  status: string;
  connectorUrl: string;
}

// ─── Portal API Client ────────────────────────────────────────────────────────

export class PortalClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private readonly backendUrl: string;
  private readonly keycloakUrl: string;
  private readonly credentials: PortalAdminCredentials;

  constructor(
    environment: PortalEnvironment,
    credentials: PortalAdminCredentials,
  ) {
    this.backendUrl = PORTAL_URLS[environment].backend;
    this.keycloakUrl = PORTAL_URLS[environment].keycloak;
    this.credentials = credentials;
  }

  /** Authenticate to Cofinity-X Keycloak and cache the token. */
  async authenticate(): Promise<void> {
    const response = await fetch(this.keycloakUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        grant_type: "client_credentials",
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Portal authentication failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.token = data.access_token;
    // Expire 60s before actual expiry to avoid edge cases
    this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  }

  /** Get a valid Bearer token, refreshing if needed. */
  private async getToken(): Promise<string> {
    if (!this.token || Date.now() >= this.tokenExpiresAt) {
      await this.authenticate();
    }
    return this.token!;
  }

  /** Make an authenticated request to the portal backend. */
  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const token = await this.getToken();
    // Some portal endpoints bind [FromForm] (application/x-www-form-urlencoded)
    // rather than JSON. Pass a URLSearchParams body for those; objects are JSON.
    const isForm = body instanceof URLSearchParams;
    return fetch(`${this.backendUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": isForm
          ? "application/x-www-form-urlencoded"
          : "application/json",
      },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
  }

  /** Get technical user details including client ID and secret. */
  async getTechUserDetails(serviceAccountId: string): Promise<TechUserDetails> {
    const response = await this.request(
      "GET",
      `/serviceaccount/owncompany/serviceaccounts/${serviceAccountId}`,
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to get tech user ${serviceAccountId}: ${response.status} — ${error}`,
      );
    }

    return (await response.json()) as TechUserDetails;
  }

  /** List all registered connectors for the organization (paginated). */
  async listConnectors(): Promise<ConnectorRegistration[]> {
    const connectors: ConnectorRegistration[] = [];
    let page = 0;
    let totalPages = 1;

    while (page < totalPages) {
      const response = await this.request(
        "GET",
        `/connectors?page=${page}&size=15`,
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(
          `Failed to list connectors: ${response.status} — ${error}`,
        );
      }

      const data = (await response.json()) as {
        meta: { totalPages: number };
        content: ConnectorRegistration[];
      };
      totalPages = data.meta.totalPages;
      connectors.push(...data.content);
      page++;
    }

    return connectors;
  }

  /** Register a connector in the portal. Returns the created registration. */
  async registerConnector(
    name: string,
    connectorUrl: string,
    serviceAccountId: string,
    location: string = "DE",
  ): Promise<ConnectorRegistration> {
    // POST /connectors is an ASP.NET [FromForm] endpoint binding
    // ConnectorInputModel (Name, ConnectorUrl, Location [2-char country code],
    // TechnicalUserId). It expects form-encoded fields with these PascalCase
    // names — sending JSON yields a 400 "field required" for every field.
    const form = new URLSearchParams({
      Name: name,
      ConnectorUrl: connectorUrl,
      Location: location,
      TechnicalUserId: serviceAccountId,
    });

    const response = await this.request("POST", "/connectors", form);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to register connector "${name}": ${response.status} — ${error}`,
      );
    }

    const result = (await response.json()) as string | ConnectorRegistration;
    // The portal may return just the ID string or the full registration object
    if (typeof result === "string") {
      return { id: result, name, status: "ACTIVE", connectorUrl };
    }
    return result;
  }

  /** Deregister a connector from the portal. */
  async deregisterConnector(portalConnectorId: string): Promise<void> {
    const response = await this.request(
      "DELETE",
      `/connectors/${portalConnectorId}`,
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to deregister connector ${portalConnectorId}: ${response.status} — ${error}`,
      );
    }
  }
}

// ─── Secrets Manager Helpers ──────────────────────────────────────────────────

export class SecretsHelper {
  private readonly client: SecretsManagerClient;

  constructor(region?: string) {
    this.client = new SecretsManagerClient({ region });
  }

  /** Read portal admin credentials from Secrets Manager. */
  async getAdminCredentials(secretId: string): Promise<PortalAdminCredentials> {
    const result = await this.client.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );

    if (!result.SecretString) {
      throw new Error("Admin secret has no value");
    }

    const parsed = JSON.parse(result.SecretString);
    if (!parsed.clientId || !parsed.clientSecret) {
      throw new Error(
        'Admin secret must contain "clientId" and "clientSecret" fields',
      );
    }

    return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
  }

  /** Write the OAuth client secret for an EDC connector. */
  async putConnectorSecret(connectorId: string, secret: string): Promise<void> {
    const secretId = `${connectorId}/edc.iam.sts.oauth.client.secret`;
    await this.client.send(
      new PutSecretValueCommand({ SecretId: secretId, SecretString: secret }),
    );
  }
}
