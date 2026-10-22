// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-deploy finalization, run as a CodeBuild step after the Deploy stage.
 *
 *   BaSyx: per BPNL with a basyx entry or a BaSyx stack, create or update the
 *   DTR offer on its dtrConnector, remove it from the BPNL's other connectors,
 *   and delete the BaSyx stack once its entry is gone.
 *
 *   Orphans: delete every connector stack of this deployment whose connector
 *   file is gone. The stack's PortalConnector resource removes the portal
 *   registration and the technical user.
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
  StackStatus,
  waitUntilStackDeleteComplete,
} from "@aws-sdk/client-cloudformation";

import {
  DeploymentConfig,
  DeploymentYaml,
  basyxStackName,
  basyxEntries,
  connectorBpnl,
  loadDeploymentConfig,
} from "../config/config";
import { BasyxOutputs, buildDtrDefinition, ensureDtr, removeDtr } from "./dtr";
import { ManagementRequest, managementApi } from "./management-api";

const MANAGEMENT_URL_OUTPUT_KEY = "ManagementApiUrl";
const STACK_DELETE_TIMEOUT_SECONDS = 1800;

interface BasyxDeps {
  /** BPNLs that have a BaSyx stack that is not deleted. */
  liveBasyxStacks: () => Promise<Set<string>>;
  /** The BaSyx stack outputs of a BPNL, or undefined if not (yet) there. */
  readOutputs: (bpnl: string) => Promise<BasyxOutputs | undefined>;
  api: (connectorId: string) => ManagementRequest;
  deleteBasyxStack: (bpnl: string) => Promise<void>;
}

/**
 * The DTR offer and orphan BaSyx stacks, per BPNL that has a basyx entry or a
 * BaSyx stack. On the dtrConnector the offer is created or updated; on the
 * BPNL's other connectors it is removed; a BaSyx stack whose entry is gone is
 * deleted after its offer. Deployments without BaSyx make no calls. Returns
 * the BPNLs that failed.
 */
export async function reconcileBasyx(
  config: DeploymentConfig,
  deps: BasyxDeps,
): Promise<string[]> {
  const targets = new Map(
    basyxEntries(config).map((b) => [b.bpnl, b.dtrConnectorId]),
  );
  const live = await deps.liveBasyxStacks();
  const bpnls = [...new Set([...targets.keys(), ...live])].sort();
  const failures: string[] = [];

  for (const bpnl of bpnls) {
    const log = (msg: string) =>
      console.log(`[portal/finalize] BaSyx ${bpnl}: ${msg}`);
    try {
      const target = targets.get(bpnl);
      if (target) {
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
            connectorBpnl(config.deployment, c) === bpnl,
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

  const deploymentPath = join(configPath, "deployment.yaml");
  if (!existsSync(deploymentPath)) {
    console.log("[portal/finalize] No deployment.yaml found, skipping.");
    return;
  }

  // Already validated by synth in this pipeline run.
  const config = loadDeploymentConfig(configPath);
  const region = process.env.AWS_REGION ?? "";
  const cfn = new CloudFormationClient();

  // ── BaSyx: DTR offers and orphan BaSyx stacks ─────────────────────────────

  const managementBaseUrl = await resolveApiBaseUrl(
    cfn,
    stackPrefix,
    config.deployment,
    "management",
    MANAGEMENT_URL_OUTPUT_KEY,
  );
  const failures = await reconcileBasyx(config, {
    liveBasyxStacks: () => liveStacks(cfn, basyxStackName(stackPrefix, "")),
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
    return ["BaSyx"];
  });

  // ── Orphan connector stacks ───────────────────────────────────────────────

  const connectorPrefix = `${stackPrefix}-Connector-`;
  const declared = new Set(config.connectors.map((c) => c.connectorId));
  for (const connectorId of await liveStacks(cfn, connectorPrefix)) {
    if (declared.has(connectorId)) continue;
    console.log(`[portal/finalize] ${connectorId}: orphan, deleting stack...`);
    try {
      await deleteStack(cfn, `${connectorPrefix}${connectorId}`);
      console.log(`[portal/finalize] ${connectorId}: stack deleted.`);
    } catch (err) {
      console.error(
        `[portal/finalize] ${connectorId}: stack deletion failed — ${(err as Error).message}`,
      );
      failures.push(connectorId);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Finalization failed for ${failures.join(", ")}; retried on the next run.`,
    );
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

/** Name suffixes of the live (not deleted) stacks whose name starts with prefix. */
async function liveStacks(
  cfn: CloudFormationClient,
  prefix: string,
): Promise<Set<string>> {
  const StackStatusFilter = Object.values(StackStatus).filter(
    (s) => s !== StackStatus.DELETE_COMPLETE,
  );
  const names = new Set<string>();
  for await (const page of paginateListStacks(
    { client: cfn },
    { StackStatusFilter },
  )) {
    for (const s of page.StackSummaries ?? []) {
      if (s.StackName?.startsWith(prefix)) {
        names.add(s.StackName.slice(prefix.length));
      }
    }
  }
  return names;
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
