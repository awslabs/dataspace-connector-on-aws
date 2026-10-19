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
 *   Phase A2 — BaSyx
 *     Per BPNL with an enabled basyx entry or a BaSyx stack: create or update
 *     the DTR offer on its dtrConnector, remove it from the BPNL's other
 *     connectors, and delete the BaSyx stack once its entry is gone.
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

import { existsSync } from "fs";
import { join, resolve } from "path";

import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
  paginateListStacks,
  waitUntilStackDeleteComplete,
} from "@aws-sdk/client-cloudformation";

import {
  ConnectorYaml,
  DEFAULT_DEPLOYMENT_NAME,
  DeploymentConfig,
  DeploymentYaml,
  EDC_SECRETS_MANAGER_ALIASES,
  basyxStackName,
  deriveAdminSecretName,
  deriveSecretPrefix,
  enabledBasyx,
  loadDeploymentConfig,
  resolveConnectorIdentity,
} from "../config/config";
import { ConnectorRegistration, PortalClient, SecretsHelper } from "./client";
import { BasyxOutputs, buildDtrDefinition, ensureDtr, removeDtr } from "./dtr";
import { ManagementRequest, managementApi } from "./management-api";
import { ConnectorState, nextState, StateStore } from "./state";

const DSP_URL_OUTPUT_KEY = "DspApiUrl";
const MANAGEMENT_URL_OUTPUT_KEY = "ManagementApiUrl";
const STACK_DELETE_TIMEOUT_SECONDS = 600;

interface RegisterDeps {
  getClient: (orgKey: string) => Promise<PortalClient | null>;
  registryByTenant: Map<string, Map<string, ConnectorRegistration>>;
  store: Pick<StateStore, "save">;
  secrets: Pick<SecretsHelper, "putConnectorSecret">;
}

/**
 * Phase A: register every deployed connector, isolating per-connector failures.
 * A connector already at the portal is self-healed (its id recorded, never
 * re-registered); a failure is logged, left at IDENTITY_READY, and does not
 * block the others. Returns the ids that failed so the caller can fail the step
 * after Phase B cleanup has run.
 */
export async function registerReadyConnectors(
  rows: ConnectorState[],
  currentConnectors: ConnectorYaml[],
  deploymentName: string,
  dspBaseUrl: string | undefined,
  deps: RegisterDeps,
): Promise<string[]> {
  const { getClient, registryByTenant, store, secrets } = deps;
  const currentIds = new Set(currentConnectors.map((c) => c.connectorId));
  const registrationFailures: string[] = [];

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

    try {
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
      console.log(
        `[portal/finalize] ${row.connectorId}: OAuth secret written.`,
      );

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
    } catch (err) {
      console.error(
        `[portal/finalize] ${row.connectorId}: registration failed, left at IDENTITY_READY — ${(err as Error).message}`,
      );
      registrationFailures.push(row.connectorId);
    }
  }

  return registrationFailures;
}

interface BasyxDeps {
  /** BPNLs that have a BaSyx stack that is not deleted. */
  liveBasyxStacks: () => Promise<Set<string>>;
  /** The BaSyx stack outputs of a BPNL, or undefined if not (yet) there. */
  readOutputs: (bpnl: string) => Promise<BasyxOutputs | undefined>;
  api: (connectorId: string) => ManagementRequest;
  deleteBasyxStack: (bpnl: string) => Promise<void>;
}

/**
 * Phase A2: the DTR offer and orphan BaSyx stacks, per BPNL that has an
 * enabled basyx entry or a BaSyx stack. On the dtrConnector the offer is
 * created or updated; on the BPNL's other deployed connectors it is removed;
 * a BaSyx stack whose entry is gone is deleted after its offer. Deployments
 * without BaSyx make no calls. Returns the BPNLs that failed.
 */
export async function reconcileBasyx(
  config: DeploymentConfig,
  rows: ConnectorState[],
  deps: BasyxDeps,
): Promise<string[]> {
  const targets = new Map(
    enabledBasyx(config).map((b) => [b.bpnl, b.dtrConnectorId]),
  );
  const live = await deps.liveBasyxStacks();
  const bpnls = [...new Set([...targets.keys(), ...live])].sort();
  const deployed = new Set(
    rows
      .filter((r) => r.phase !== "IDENTITY_PENDING")
      .map((r) => r.connectorId),
  );
  const failures: string[] = [];

  for (const bpnl of bpnls) {
    const log = (msg: string) =>
      console.log(`[portal/finalize] BaSyx ${bpnl}: ${msg}`);
    try {
      const target = targets.get(bpnl);
      if (target && deployed.has(target)) {
        const outputs = await deps.readOutputs(bpnl);
        if (!outputs) {
          log(`stack outputs not found, DTR offer skipped this run.`);
        } else if (
          await ensureDtr(deps.api(target), buildDtrDefinition(outputs))
        ) {
          log(`DTR offer written on ${target}.`);
        }
      }

      const others = config.connectors
        .filter(
          (c) =>
            c.connectorId !== target &&
            deployed.has(c.connectorId) &&
            resolveConnectorIdentity(config.deployment, c).participantId ===
              bpnl,
        )
        .map((c) => c.connectorId);
      for (const connectorId of others) {
        if (
          await removeDtr(deps.api(connectorId), (msg) =>
            console.warn(`[portal/finalize] ${connectorId}: ${msg}`),
          )
        ) {
          log(`DTR offer removed from ${connectorId}.`);
        }
      }

      if (!target && live.has(bpnl)) {
        await deps.deleteBasyxStack(bpnl);
        log(`orphan stack deleted.`);
      }
    } catch (err) {
      console.error(
        `[portal/finalize] BaSyx ${bpnl}: failed — ${(err as Error).message}`,
      );
      failures.push(bpnl);
    }
  }

  return failures;
}

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

  // Already validated by synth in this pipeline run.
  const config = loadDeploymentConfig(configPath);
  const { deployment } = config;
  const { environment } = deployment.portal;
  const deploymentName = process.env.DEPLOYMENT_NAME ?? DEFAULT_DEPLOYMENT_NAME;
  const region = process.env.AWS_REGION ?? "";

  const currentConnectors = config.connectors;
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

  const dspBaseUrl = await resolveApiBaseUrl(
    cfn,
    stackPrefix,
    deployment,
    "protocol",
    DSP_URL_OUTPUT_KEY,
  );

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

  const registrationFailures = await registerReadyConnectors(
    rows,
    currentConnectors,
    deploymentName,
    dspBaseUrl,
    { getClient, registryByTenant, store, secrets },
  );

  // ── Phase A2: DTR offer and orphan BaSyx stacks ───────────────────────────
  // Before Phase B: a dtrConnector stack can only be deleted once the BaSyx
  // stack that imports its security group is gone.

  const managementBaseUrl = await resolveApiBaseUrl(
    cfn,
    stackPrefix,
    deployment,
    "management",
    MANAGEMENT_URL_OUTPUT_KEY,
  );
  const basyxFailures = await reconcileBasyx(config, rows, {
    liveBasyxStacks: () => liveBasyxStacks(cfn, stackPrefix),
    readOutputs: (bpnl) => readBasyxOutputs(cfn, stackPrefix, bpnl),
    api: (connectorId) => {
      if (!managementBaseUrl) {
        throw new Error("management API URL unavailable");
      }
      return managementApi(managementBaseUrl, connectorId, region);
    },
    deleteBasyxStack: (bpnl) =>
      deleteStack(cfn, basyxStackName(stackPrefix, bpnl)),
  }).catch((err: Error) => {
    console.error(`[portal/finalize] BaSyx: failed — ${err.message}`);
    return ["*"];
  });

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
      await deleteStack(cfn, stackName);
      console.log(`[portal/finalize] ${row.connectorId}: stack deleted.`);
    } catch (err) {
      console.error(
        `[portal/finalize] ${row.connectorId}: stack deletion failed — ${(err as Error).message}`,
      );
      continue;
    }

    await store.remove(row.connectorId);
    console.log(`[portal/finalize] ${row.connectorId}: DDB row removed.`);
  }

  const problems: string[] = [];
  if (registrationFailures.length > 0) {
    problems.push(
      `${registrationFailures.length} connector(s) failed to register (${registrationFailures.join(", ")}); ` +
        `their state remains IDENTITY_READY and will be retried on the next run`,
    );
  }
  if (basyxFailures.length > 0) {
    problems.push(
      `BaSyx reconcile failed for ${basyxFailures.join(", ")}; retried on the next run`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`${problems.join(". ")}.`);
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

/** Base URL (with trailing slash) of a SharedInfra API, for the custom domain or the output. */
async function resolveApiBaseUrl(
  cfn: CloudFormationClient,
  stackPrefix: string,
  deployment: DeploymentYaml,
  domainPath: string,
  outputKey: string,
): Promise<string | undefined> {
  if (deployment.domainName) {
    return `https://${deployment.domainName}/${domainPath}/`;
  }
  try {
    const value = (await stackOutputs(cfn, `${stackPrefix}-SharedInfra`))?.get(
      outputKey,
    );
    if (value) return value.endsWith("/") ? value : `${value}/`;
  } catch (err) {
    console.error(
      `[portal/finalize] Failed to read SharedInfra outputs: ${(err as Error).message}`,
    );
  }
  return undefined;
}

/** A stack's outputs by key, or undefined if the stack does not exist. */
async function stackOutputs(
  cfn: CloudFormationClient,
  stackName: string,
): Promise<Map<string, string> | undefined> {
  try {
    const result = await cfn.send(
      new DescribeStacksCommand({ StackName: stackName }),
    );
    return new Map(
      (result.Stacks?.[0]?.Outputs ?? []).map((o) => [
        o.OutputKey ?? "",
        o.OutputValue ?? "",
      ]),
    );
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

async function readBasyxOutputs(
  cfn: CloudFormationClient,
  stackPrefix: string,
  bpnl: string,
): Promise<BasyxOutputs | undefined> {
  const o = await stackOutputs(cfn, basyxStackName(stackPrefix, bpnl));
  const get = (key: string) => o?.get(key);
  const outputs = {
    dtrUrl: get("DtrUrl"),
    tokenUrl: get("TokenUrl"),
    clientId: get("ClientId"),
    scope: get("Scope"),
    clientSecretAlias: get("ClientSecretAlias"),
  };
  return Object.values(outputs).every(Boolean)
    ? (outputs as BasyxOutputs)
    : undefined;
}

/** BPNLs with a BaSyx stack of this deployment that is not deleted. */
async function liveBasyxStacks(
  cfn: CloudFormationClient,
  stackPrefix: string,
): Promise<Set<string>> {
  const prefix = basyxStackName(stackPrefix, "");
  const bpnls = new Set<string>();
  for await (const page of paginateListStacks({ client: cfn }, {})) {
    for (const s of page.StackSummaries ?? []) {
      if (s.StackStatus === "DELETE_COMPLETE") continue;
      if (s.StackName?.startsWith(prefix)) {
        bpnls.add(s.StackName.slice(prefix.length));
      }
    }
  }
  return bpnls;
}

/** Deletes a stack and waits; a stack that does not exist counts as deleted. */
async function deleteStack(
  cfn: CloudFormationClient,
  stackName: string,
): Promise<void> {
  try {
    await cfn.send(new DeleteStackCommand({ StackName: stackName }));
    await waitUntilStackDeleteComplete(
      { client: cfn, maxWaitTime: STACK_DELETE_TIMEOUT_SECONDS },
      { StackName: stackName },
    );
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

function isNotFound(err: unknown): boolean {
  const msg = (err as Error).message ?? "";
  return msg.includes("does not exist") || msg.includes("ResourceNotFound");
}

// Entrypoint guard: run only when invoked directly (node dist/portal/finalize.js),
// not when imported by tests.
if (process.argv[1]?.endsWith("finalize.js")) {
  main().catch((err) => {
    console.error(`[portal/finalize] FATAL: ${err.message}`);
    process.exit(1);
  });
}
