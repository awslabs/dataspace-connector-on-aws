// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-synth provisioning script for Cofinity-X Portal integration.
 *
 * Runs as part of the CDK Pipeline Synth step, between TypeScript compilation
 * and `cdk synth`. For each connector YAML that declares an `edcTechnicalUserId`
 * but no `edcIam`, it assembles the `edcIam` block from:
 *   - organization-wide identity values in deployment.yaml (portal.identity)
 *   - the connector's OAuth client ID, read fresh from the portal API
 * and writes it into the connector YAML (workspace-local only).
 *
 * Stateless by design: the portal is the source of truth, so every run is an
 * idempotent read. Connectors that already carry an explicit `edcIam` block are
 * left untouched.
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

interface DeploymentYamlWithPortal {
  portal?: {
    environment: PortalEnvironment;
    identity: PortalIdentity;
  };
  [key: string]: unknown;
}

interface ConnectorYamlWithPortal {
  connectorId: string;
  edcTechnicalUserId?: string;
  edcIam?: Record<string, string>;
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

  const deploymentPath = join(configPath, "deployment.yaml");
  if (!existsSync(deploymentPath)) {
    console.log("[portal/provision] No deployment.yaml found, skipping.");
    return;
  }

  const deployment = yaml.load(
    readFileSync(deploymentPath, "utf-8"),
  ) as DeploymentYamlWithPortal;

  if (!deployment.portal) {
    console.log(
      "[portal/provision] No portal section in deployment.yaml, skipping.",
    );
    return;
  }

  const { environment, identity } = deployment.portal;
  if (!environment || !identity) {
    throw new Error(
      "[portal/provision] portal section requires 'environment' and 'identity'",
    );
  }

  const connectorsDir = join(configPath, "connectors");
  if (!existsSync(connectorsDir)) {
    console.log("[portal/provision] No connectors/ directory, skipping.");
    return;
  }

  // Select connectors that need edcIam populated from the portal.
  const pending = readdirSync(connectorsDir)
    .filter((f) => f.startsWith("connector-") && f.endsWith(".yaml"))
    .map((file) => ({
      file,
      data: yaml.load(
        readFileSync(join(connectorsDir, file), "utf-8"),
      ) as ConnectorYamlWithPortal,
    }))
    .filter(({ file, data }) => {
      if (data.edcIam) {
        console.log(`[portal/provision] ${file}: edcIam present, skipping.`);
        return false;
      }
      if (!data.edcTechnicalUserId) {
        // Neither edcIam nor a tech user — config-loader will reject this.
        return false;
      }
      return true;
    });

  if (pending.length === 0) {
    console.log("[portal/provision] Nothing to provision. Done.");
    return;
  }

  console.log(
    `[portal/provision] Populating edcIam for ${pending.length} connector(s).`,
  );

  const adminCreds = await new SecretsHelper().getAdminCredentials(
    ADMIN_SECRET_NAME,
  );
  const portal = new PortalClient(environment, adminCreds);
  await portal.authenticate();

  for (const { file, data } of pending) {
    const { connectorId } = data;
    const techUserId = data.edcTechnicalUserId!;

    const techUser = await portal.getTechUserDetails(techUserId);
    if (techUser.status !== "ACTIVE") {
      throw new Error(
        `[portal/provision] ${connectorId}: tech user ${techUserId} is not ACTIVE ` +
          `(status: ${techUser.status}). Wait for DIM provisioning to complete in the portal.`,
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

    // edcTechnicalUserId is replaced by the resolved edcIam block for synth.
    const { edcTechnicalUserId: _drop, ...rest } = data;
    void _drop;
    writeFileSync(
      join(connectorsDir, file),
      yaml.dump({ ...rest, edcIam }, { lineWidth: -1 }),
      "utf-8",
    );
    console.log(
      `[portal/provision] ${connectorId}: edcIam written to ${file}.`,
    );
  }

  console.log("[portal/provision] Done.");
}

main().catch((err) => {
  console.error(`[portal/provision] FATAL: ${err.message}`);
  process.exit(1);
});
