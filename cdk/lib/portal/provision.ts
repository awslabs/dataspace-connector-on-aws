// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-synth reconcile loop for Cofinity-X Portal integration.
 *
 * Runs inside the CDK Pipeline Synth step, before `cdk synth`. For each
 * connector it reconciles the desired config (YAML) against observed state
 * (DynamoDB) and does the minimum outstanding work:
 *
 *   1. Merge the effective identity (deployment default + connector override).
 *   2. Gate on portal-side prerequisites (identity complete, admin secret
 *      populated, technical user ACTIVE). A failure leaves the connector at
 *      IDENTITY_PENDING and retries next run, never failing the whole run.
 *   3. On success, resolve edcIam (identity + the technical user's clientId),
 *      emit it to the ephemeral file, and advance the phase to IDENTITY_READY.
 *
 * Outputs (consumed within the same Synth step by `cdk synth`): the resolved
 * edcIam file (READY connectors only) and the active-BPNL set (union of config
 * BPNLs and live DDB orgKeys, so SharedInfra keeps a tenant's admin secret alive
 * through the run that offboards its last connector).
 *
 * Usage: node dist/portal/provision.js --config-path=<path>
 */

import { resolve } from "path";

import {
  EdcIam,
  deriveAdminSecretName,
  isIdentityComplete,
  loadDeploymentConfig,
  resolveConnectorIdentity,
} from "../config/config";
import { PortalClient, PortalEnvironment, SecretsHelper } from "./client";
import { nextState, StateStore } from "./state";
import { ResolvedEdcIam, writeProvisionOutput } from "./provision-output";

async function main(): Promise<void> {
  const configPathArg = process.argv.find((a) =>
    a.startsWith("--config-path="),
  );
  if (!configPathArg) {
    console.error("Usage: node dist/portal/provision.js --config-path=<path>");
    process.exit(1);
  }
  const configPath = resolve(configPathArg.split("=")[1]);

  const tableName = process.env.STATE_TABLE_NAME;
  if (!tableName) {
    throw new Error("[portal/provision] STATE_TABLE_NAME env var is required.");
  }

  const { deployment, connectors } = loadDeploymentConfig(configPath);
  const environment = deployment.portal.environment as PortalEnvironment;

  const store = new StateStore(tableName);
  const secrets = new SecretsHelper();

  // Union of config BPNLs and live DDB orgKeys. Seeding from existing rows keeps
  // a tenant's admin secret alive through the run that offboards its last connector.
  const activeBpnls = new Set<string>();
  for (const row of await store.list()) {
    if (row.orgKey) activeBpnls.add(row.orgKey);
  }

  const resolved: ResolvedEdcIam = {};

  // One authenticated PortalClient per tenant (BPNL). null means the admin
  // secret is missing or unpopulated, so that tenant's connectors stay PENDING.
  const clients = new Map<string, PortalClient | null>();
  const getClient = async (bpnl: string): Promise<PortalClient | null> => {
    if (clients.has(bpnl)) return clients.get(bpnl) ?? null;
    const secretName = deriveAdminSecretName(bpnl);
    let client: PortalClient | null = null;
    try {
      const creds = await secrets.getAdminCredentials(secretName);
      client = new PortalClient(environment, creds);
      await client.authenticate();
    } catch (err) {
      console.warn(
        `[portal/provision] admin secret ${secretName} unavailable: ${(err as Error).message}`,
      );
    }
    clients.set(bpnl, client);
    return client;
  };

  for (const connector of connectors) {
    const { connectorId, serviceAccountId } = connector;
    const identity = resolveConnectorIdentity(deployment, connector);
    const bpnl = identity.participantId;
    if (bpnl) activeBpnls.add(bpnl);

    const current = await store.ensureRow(connectorId, bpnl ?? "");

    const pend = async (reason: string): Promise<void> => {
      console.warn(`[portal/provision] ${connectorId}: PENDING (${reason}).`);
      const { state, changed } = nextState(current, {
        orgKey: bpnl ?? current.orgKey,
      });
      if (changed) await store.save(state);
    };

    if (!isIdentityComplete(identity)) {
      await pend("effective identity incomplete");
      continue;
    }

    const client = await getClient(identity.participantId);
    if (!client) {
      await pend("admin secret not populated");
      continue;
    }

    let clientId: string;
    try {
      const techUser = await client.getTechUserDetails(serviceAccountId);
      if (techUser.status !== "ACTIVE") {
        await pend(
          `technical user ${serviceAccountId} not ACTIVE (${techUser.status})`,
        );
        continue;
      }
      clientId = techUser.clientId;
    } catch (err) {
      await pend(
        `technical user ${serviceAccountId} unresolved: ${(err as Error).message}`,
      );
      continue;
    }

    const edcIam: EdcIam = { ...identity, stsOauthClientId: clientId };
    resolved[connectorId] = edcIam;

    const { state, changed } = nextState(current, {
      phase: "IDENTITY_READY",
      orgKey: identity.participantId,
    });
    if (changed) await store.save(state);
    console.log(`[portal/provision] ${connectorId}: IDENTITY_READY.`);
  }

  writeProvisionOutput(configPath, resolved, [...activeBpnls]);
  console.log(
    `[portal/provision] Done. ${Object.keys(resolved).length} connector(s) ready, ${activeBpnls.size} tenant(s).`,
  );
}

main().catch((err) => {
  console.error(`[portal/provision] FATAL: ${err.message}`);
  process.exit(1);
});
