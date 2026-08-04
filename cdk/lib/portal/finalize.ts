// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-deploy finalization script for Cofinity-X Portal integration.
 *
 * Runs as a CodeBuild step after the Deploy stage. Reads the connector state
 * table and processes two phases:
 *
 *   Phase A — Register deployed connectors
 *     For each IDENTITY_READY connector: write its OAuth secret to Secrets
 *     Manager, register it in the portal (making it discoverable), and advance
 *     its phase to REGISTERED.
 *
 *   Phase B — Orphan cleanup
 *     For each DDB row whose connectorId is not in the current config:
 *     deregister from the portal (by stored portalConnectorId, so manually-
 *     registered connectors are never touched), delete the CloudFormation
 *     stack, and remove the DDB row.
 *
 * Admin secrets are grouped by BPNL (orgKey). One PortalClient per tenant;
 * cleanup uses the stored orgKey to authenticate even after the YAML is gone.
 * Admin-secret deletion is CDK-owned (SharedInfra reconciles from the active
 * BPNL set), so finalize never deletes secrets.
 *
 * Usage: node dist/portal/finalize.js --config-path=<path> --stack-prefix=<prefix>
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import * as yaml from "js-yaml";

import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
  waitUntilStackDeleteComplete,
} from "@aws-sdk/client-cloudformation";

import {
  ConnectorYaml,
  DEFAULT_DEPLOYMENT_NAME,
  DeploymentYaml,
  EDC_SECRETS_MANAGER_ALIASES,
  deriveAdminSecretName,
  deriveSecretPrefix,
} from "../config/config";
import { ConnectorRegistration, PortalClient, SecretsHelper } from "./client";
import { nextState, StateStore } from "./state";

const DSP_URL_OUTPUT_KEY = "DspApiUrl";
const STACK_DELETE_TIMEOUT_SECONDS = 600;

async function main(): Promise<void> {
  const configPath = requireArg("--config-path=");
  const stackPrefix = requireArg("--stack-prefix=");

  const tableName = process.env.STATE_TABLE_NAME;
  if (!tableName) {
    throw new Error(
      "[portal/finalize] STATE_TABLE_NAME environment variable is required.",
    );
  }

  const deploymentPath = join(configPath, "deployment.yaml");
  if (!existsSync(deploymentPath)) {
    console.log("[portal/finalize] No deployment.yaml found, skipping.");
    return;
  }

  const deployment = yaml.load(
    readFileSync(deploymentPath, "utf-8"),
  ) as DeploymentYaml;

  if (!deployment.portal?.environment) {
    console.log(
      "[portal/finalize] No portal section in deployment.yaml, skipping.",
    );
    return;
  }
  const { environment } = deployment.portal;
  const deploymentName = process.env.DEPLOYMENT_NAME ?? DEFAULT_DEPLOYMENT_NAME;

  const currentConnectors = readCurrentConnectors(configPath);
  const currentIds = new Set(currentConnectors.map((c) => c.connectorId));

  const store = new StateStore(tableName);
  const cfn = new CloudFormationClient();
  const secrets = new SecretsHelper();
  const rows = await store.list();

  // One authenticated PortalClient per tenant (BPNL). null means the admin
  // secret is unavailable, so that tenant's connectors are skipped this run.
  const clients = new Map<string, PortalClient | null>();
  const getClient = async (orgKey: string): Promise<PortalClient | null> => {
    if (clients.has(orgKey)) return clients.get(orgKey) ?? null;
    let client: PortalClient | null = null;
    try {
      const creds = await secrets.getAdminCredentials(
        deriveAdminSecretName(deploymentName, orgKey),
      );
      client = new PortalClient(environment, creds);
      await client.authenticate();
    } catch {
      console.warn(
        `[portal/finalize] Cannot load admin secret for BPNL ${orgKey}, skipping its connectors.`,
      );
    }
    clients.set(orgKey, client);
    return client;
  };

  const dspBaseUrl = await resolveDspBaseUrl(cfn, stackPrefix, deployment);

  // ── Phase A: register IDENTITY_READY connectors ───────────────────────────

  // One portal list call per tenant yields a name -> registration map, used to
  // self-heal (registered on the portal but the row never recorded it) and to
  // avoid duplicate registration.
  const registryByTenant = new Map<
    string,
    Map<string, ConnectorRegistration>
  >();
  const uniqueOrgs = [...new Set(rows.map((r) => r.orgKey).filter(Boolean))];
  for (const orgKey of uniqueOrgs) {
    const client = await getClient(orgKey);
    if (!client) continue;
    try {
      const list = await client.listConnectors();
      registryByTenant.set(orgKey, new Map(list.map((c) => [c.name, c])));
    } catch (err) {
      console.error(
        `[portal/finalize] Failed to list connectors for BPNL ${orgKey}: ${(err as Error).message}`,
      );
    }
  }

  for (const row of rows) {
    if (!currentIds.has(row.connectorId)) continue; // orphan — handled in Phase B
    if (row.phase === "IDENTITY_PENDING") continue; // not deployed yet

    const connector = currentConnectors.find(
      (c) => c.connectorId === row.connectorId,
    )!;
    const client = await getClient(row.orgKey);
    if (!client) continue;

    const registry = registryByTenant.get(row.orgKey);
    if (!registry) continue;

    const existing = registry.get(row.connectorId);
    if (existing && row.phase === "REGISTERED") continue; // nothing to do
    if (existing) {
      // Registered on the portal but the row was not updated (previous crash).
      const { state } = nextState(row, {
        phase: "REGISTERED",
        portalConnectorId: existing.id,
      });
      await store.save(state);
      console.log(
        `[portal/finalize] ${row.connectorId}: self-healed, recorded existing registration.`,
      );
      continue;
    }

    console.log(`[portal/finalize] ${row.connectorId}: finalizing...`);

    // Write the OAuth secret before registering so the connector can
    // authenticate the moment it becomes discoverable.
    const techUser = await client.getTechUserDetails(
      connector.serviceAccountId,
    );
    const oauthSecretId = `${deriveSecretPrefix(deploymentName, row.connectorId)}${EDC_SECRETS_MANAGER_ALIASES.DCP_STS_OAUTH_CLIENT_SECRET_ALIAS}`;
    await secrets.putConnectorSecret(oauthSecretId, techUser.secret);
    console.log(`[portal/finalize] ${row.connectorId}: OAuth secret written.`);

    if (!dspBaseUrl) {
      console.warn(
        `[portal/finalize] ${row.connectorId}: DSP URL unavailable, skipping registration (retries next run).`,
      );
      continue;
    }

    const reg = await client.registerConnector(
      row.connectorId,
      `${dspBaseUrl}${row.connectorId}`,
      connector.serviceAccountId,
    );
    const { state } = nextState(row, {
      phase: "REGISTERED",
      portalConnectorId: reg.id,
    });
    await store.save(state);
    console.log(`[portal/finalize] ${row.connectorId}: registered.`);
  }

  // ── Phase B: orphan cleanup ───────────────────────────────────────────────

  for (const row of rows) {
    if (currentIds.has(row.connectorId)) continue; // still declared

    console.log(`[portal/finalize] ${row.connectorId}: orphan, cleaning up...`);

    // Deregister by stored id (exact; never touches externally-registered
    // connectors). A row without a portalConnectorId was never registered.
    if (row.portalConnectorId) {
      const client = await getClient(row.orgKey);
      if (client) {
        try {
          await client.deregisterConnector(row.portalConnectorId);
          console.log(`[portal/finalize] ${row.connectorId}: deregistered.`);
        } catch (err) {
          console.error(
            `[portal/finalize] ${row.connectorId}: deregistration failed, skipping — ${(err as Error).message}`,
          );
          continue;
        }
      }
    }

    // Delete the stack by deterministic name. A connector that stayed PENDING
    // never deployed a stack; treat "not found" as already clean.
    const stackName = `${stackPrefix}-Connector-${row.connectorId}`;
    try {
      await cfn.send(new DeleteStackCommand({ StackName: stackName }));
      await waitUntilStackDeleteComplete(
        { client: cfn, maxWaitTime: STACK_DELETE_TIMEOUT_SECONDS },
        { StackName: stackName },
      );
      console.log(`[portal/finalize] ${row.connectorId}: stack deleted.`);
    } catch (err) {
      const msg = (err as Error).message;
      if (
        !msg.includes("does not exist") &&
        !msg.includes("ResourceNotFound")
      ) {
        console.error(
          `[portal/finalize] ${row.connectorId}: stack deletion failed — ${msg}`,
        );
        continue;
      }
    }

    await store.remove(row.connectorId);
    console.log(`[portal/finalize] ${row.connectorId}: DDB row removed.`);
  }

  console.log("[portal/finalize] Done.");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireArg(prefix: string): string {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) {
    console.error(
      "Usage: node dist/portal/finalize.js --config-path=<path> --stack-prefix=<prefix>",
    );
    process.exit(1);
  }
  return prefix.startsWith("--config-path")
    ? resolve(arg.split("=")[1])
    : arg.split("=")[1];
}

function readCurrentConnectors(configPath: string): ConnectorYaml[] {
  const connectorsDir = join(configPath, "connectors");
  if (!existsSync(connectorsDir)) return [];
  return readdirSync(connectorsDir)
    .filter((f) => f.startsWith("connector-") && f.endsWith(".yaml"))
    .map(
      (f) =>
        yaml.load(
          readFileSync(join(connectorsDir, f), "utf-8"),
        ) as ConnectorYaml,
    );
}

async function resolveDspBaseUrl(
  cfn: CloudFormationClient,
  stackPrefix: string,
  deployment: DeploymentYaml,
): Promise<string | undefined> {
  if (deployment.domainName) {
    return `https://${deployment.domainName}/protocol/`;
  }
  try {
    const result = await cfn.send(
      new DescribeStacksCommand({
        StackName: `${stackPrefix}-SharedInfra`,
      }),
    );
    const output = (result.Stacks?.[0]?.Outputs ?? []).find(
      (o) => o.OutputKey === DSP_URL_OUTPUT_KEY,
    );
    if (output?.OutputValue) {
      return output.OutputValue.endsWith("/")
        ? output.OutputValue
        : `${output.OutputValue}/`;
    }
  } catch (err) {
    console.error(
      `[portal/finalize] Failed to read SharedInfra outputs: ${(err as Error).message}`,
    );
  }
  return undefined;
}

main().catch((err) => {
  console.error(`[portal/finalize] FATAL: ${err.message}`);
  process.exit(1);
});
