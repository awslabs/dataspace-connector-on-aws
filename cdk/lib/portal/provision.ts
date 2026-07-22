// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-synth provisioning script for Cofinity-X Portal integration.
 *
 * Runs inside the CDK Pipeline Synth step, between TypeScript compilation and
 * `cdk synth`. For every connector it assembles the `edcIam` block from:
 *   - organization-wide identity values in deployment.yaml (portal.identity)
 *   - the connector's OAuth client ID, read fresh from the portal API
 * and writes it into the connector YAML (workspace-local only).
 *
 * Stateless by design: the portal is the source of truth, so every run is an
 * idempotent read. `edcTechnicalUserId` is retained in the file (the CDK config
 * loader requires it); `edcIam` is added alongside it.
 *
 * Usage: node dist/portal/provision.js --config-path=<path>
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import * as yaml from "js-yaml";

import { PortalClient, PortalEnvironment, SecretsHelper } from "./client";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PortalIdentity {
  trustedIssuer: string;
  stsOauthTokenUrl: string;
  stsDimUrl: string;
  participantId: string;
  dcpId: string;
  didResolver: string;
}

interface DeploymentYaml {
  portal?: { environment: PortalEnvironment; identity: PortalIdentity };
}

interface ConnectorYaml {
  connectorId: string;
  edcTechnicalUserId?: string;
  [key: string]: unknown;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ADMIN_SECRET_NAME =
  process.env.PORTAL_ADMIN_SECRET ?? "dataspace-connector/portal-admin";

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configPathArg = process.argv.find((a) =>
    a.startsWith("--config-path="),
  );
  if (!configPathArg) {
    console.error("Usage: node dist/portal/provision.js --config-path=<path>");
    process.exit(1);
  }
  const configPath = resolve(configPathArg.split("=")[1]);

  const deployment = yaml.load(
    readFileSync(join(configPath, "deployment.yaml"), "utf-8"),
  ) as DeploymentYaml;

  if (!deployment.portal?.environment || !deployment.portal?.identity) {
    throw new Error(
      "[portal/provision] deployment.yaml requires a portal section with 'environment' and 'identity'.",
    );
  }
  const { environment, identity } = deployment.portal;

  const connectorsDir = join(configPath, "connectors");
  const files = existsSync(connectorsDir)
    ? readdirSync(connectorsDir).filter(
        (f) => f.startsWith("connector-") && f.endsWith(".yaml"),
      )
    : [];

  if (files.length === 0) {
    console.log("[portal/provision] No connectors to provision. Done.");
    return;
  }

  const adminCreds = await new SecretsHelper().getAdminCredentials(
    ADMIN_SECRET_NAME,
  );
  const portal = new PortalClient(environment, adminCreds);
  await portal.authenticate();

  for (const file of files) {
    const path = join(connectorsDir, file);
    const connector = yaml.load(readFileSync(path, "utf-8")) as ConnectorYaml;

    if (!connector.edcTechnicalUserId) {
      throw new Error(
        `[portal/provision] ${file}: 'edcTechnicalUserId' is required. ` +
          `Create a technical user in the Cofinity-X Portal and reference its ID.`,
      );
    }

    const techUser = await portal.getTechUserDetails(
      connector.edcTechnicalUserId,
    );
    if (techUser.status !== "ACTIVE") {
      throw new Error(
        `[portal/provision] ${connector.connectorId}: tech user ${connector.edcTechnicalUserId} ` +
          `is not ACTIVE (status: ${techUser.status}). Wait for DIM provisioning to complete.`,
      );
    }

    const edcIam = {
      trustedIssuer: identity.trustedIssuer,
      stsOauthTokenUrl: identity.stsOauthTokenUrl,
      stsOauthClientId: techUser.clientId,
      stsDimUrl: identity.stsDimUrl,
      participantId: identity.participantId,
      dcpId: identity.dcpId,
      didResolver: identity.didResolver,
    };

    writeFileSync(
      path,
      yaml.dump({ ...connector, edcIam }, { lineWidth: -1 }),
      "utf-8",
    );
    console.log(
      `[portal/provision] ${connector.connectorId}: edcIam written to ${file}.`,
    );
  }

  console.log("[portal/provision] Done.");
}

main().catch((err) => {
  console.error(`[portal/provision] FATAL: ${err.message}`);
  process.exit(1);
});
