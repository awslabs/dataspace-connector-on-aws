// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-deploy finalization script for Cofinity-X Portal integration.
 *
 * Runs as a CodeBuild step after the Deploy stage. Stateless — the portal's
 * connector registry and CloudFormation are the sources of truth:
 *
 *   1. Finalize new connectors — a connector present in the config but not yet
 *      in the portal registry gets its OAuth client secret written to Secrets
 *      Manager and is registered in the portal (making it discoverable).
 *   2. Clean up orphans — a deployed connector stack whose YAML was removed is
 *      deregistered from the portal and its stack destroyed.
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
  ListStacksCommand,
  waitUntilStackDeleteComplete,
} from "@aws-sdk/client-cloudformation";

import {
  ConnectorRegistration,
  PortalClient,
  PortalEnvironment,
  SecretsHelper,
} from "./client";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DeploymentYamlWithPortal {
  portal?: { environment: PortalEnvironment };
  domainName?: string;
  [key: string]: unknown;
}

interface ConnectorYaml {
  connectorId: string;
  edcTechnicalUserId?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ADMIN_SECRET_NAME =
  process.env.PORTAL_ADMIN_SECRET ?? "dataspace-connector/portal-admin";
const STACK_DELETE_TIMEOUT_SECONDS = 600;
const DSP_URL_OUTPUT_KEY = "DspApiUrl";

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configPath = requireArg("--config-path=");
  const stackPrefix = requireArg("--stack-prefix=");

  const deploymentPath = join(configPath, "deployment.yaml");
  if (!existsSync(deploymentPath)) {
    console.log("[portal/finalize] No deployment.yaml found, skipping.");
    return;
  }

  const deployment = yaml.load(
    readFileSync(deploymentPath, "utf-8"),
  ) as DeploymentYamlWithPortal;

  if (!deployment.portal) {
    console.log(
      "[portal/finalize] No portal section in deployment.yaml, skipping.",
    );
    return;
  }

  const currentConnectors = readCurrentConnectors(configPath);

  const cfn = new CloudFormationClient();
  const adminCreds = await new SecretsHelper().getAdminCredentials(
    ADMIN_SECRET_NAME,
  );
  const secrets = new SecretsHelper();
  const portal = new PortalClient(deployment.portal.environment, adminCreds);
  await portal.authenticate();

  // Portal registry is the source of truth for "is this connector registered".
  const registered = new Map(
    (await portal.listConnectors()).map((c) => [c.name, c]),
  );
  const dspBaseUrl = await resolveDspBaseUrl(cfn, stackPrefix, deployment);

  await finalizeNewConnectors(
    currentConnectors,
    registered,
    dspBaseUrl,
    portal,
    secrets,
  );

  await cleanupOrphans(cfn, stackPrefix, currentConnectors, registered, portal);

  console.log("[portal/finalize] Done.");
}

// ─── Phase 1: Finalize new connectors ───────────────────────────────────────

async function finalizeNewConnectors(
  current: ConnectorYaml[],
  registered: Map<string, ConnectorRegistration>,
  dspBaseUrl: string | undefined,
  portal: PortalClient,
  secrets: SecretsHelper,
): Promise<void> {
  for (const { connectorId, edcTechnicalUserId } of current) {
    if (registered.has(connectorId)) continue; // already finalized
    if (!edcTechnicalUserId) continue; // defensive: provision guarantees this is set

    console.log(`[portal/finalize] ${connectorId}: finalizing...`);

    // Write the OAuth secret before registering so the connector can
    // authenticate the moment it becomes discoverable.
    const techUser = await portal.getTechUserDetails(edcTechnicalUserId);
    await secrets.putConnectorSecret(connectorId, techUser.secret);
    console.log(`[portal/finalize] ${connectorId}: secret written.`);

    if (!dspBaseUrl) {
      console.warn(
        `[portal/finalize] ${connectorId}: DSP URL unavailable, skipping registration (retries next run).`,
      );
      continue;
    }

    await portal.registerConnector(
      connectorId,
      `${dspBaseUrl}${connectorId}`,
      edcTechnicalUserId,
    );
    console.log(`[portal/finalize] ${connectorId}: registered in portal.`);
  }
}

// ─── Phase 2: Orphan cleanup ─────────────────────────────────────────────────

async function cleanupOrphans(
  cfn: CloudFormationClient,
  stackPrefix: string,
  current: ConnectorYaml[],
  registered: Map<string, ConnectorRegistration>,
  portal: PortalClient,
): Promise<void> {
  const currentIds = new Set(current.map((c) => c.connectorId));
  const stackPattern = `${stackPrefix}-DataspaceConnector-`;

  for (const stackName of await listConnectorStacks(cfn, stackPattern)) {
    const connectorId = stackName.slice(stackPattern.length);
    if (currentIds.has(connectorId)) continue; // still declared — not an orphan

    console.log(`[portal/finalize] ${connectorId}: orphan, cleaning up...`);

    // Deregister from the portal first; skip stack deletion if it fails so we
    // never leave a registration pointing at deleted infrastructure.
    const portalConnector = registered.get(connectorId);
    if (portalConnector) {
      try {
        await portal.deregisterConnector(portalConnector.id);
        console.log(`[portal/finalize] ${connectorId}: deregistered.`);
      } catch (err) {
        console.error(
          `[portal/finalize] ${connectorId}: deregistration failed, skipping stack deletion — ${(err as Error).message}`,
        );
        continue;
      }
    }

    await cfn.send(new DeleteStackCommand({ StackName: stackName }));
    await waitUntilStackDeleteComplete(
      { client: cfn, maxWaitTime: STACK_DELETE_TIMEOUT_SECONDS },
      { StackName: stackName },
    );
    console.log(`[portal/finalize] ${connectorId}: stack deleted.`);
  }
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

/** Lists deployed connector stack names (excludes the shared-infra stack). */
async function listConnectorStacks(
  cfn: CloudFormationClient,
  stackPattern: string,
): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const result = await cfn.send(
      new ListStacksCommand({
        NextToken: nextToken,
        StackStatusFilter: [
          "CREATE_COMPLETE",
          "UPDATE_COMPLETE",
          "UPDATE_ROLLBACK_COMPLETE",
        ],
      }),
    );
    for (const s of result.StackSummaries ?? []) {
      if (s.StackName?.startsWith(stackPattern)) names.push(s.StackName);
    }
    nextToken = result.NextToken;
  } while (nextToken);
  return names;
}

/**
 * Resolves the base DSP URL (connectorId is appended by the caller).
 * Prefers the custom domain from deployment.yaml, falls back to the
 * SharedInfra stack's DSP API endpoint output.
 */
async function resolveDspBaseUrl(
  cfn: CloudFormationClient,
  stackPrefix: string,
  deployment: DeploymentYamlWithPortal,
): Promise<string | undefined> {
  if (deployment.domainName) {
    return `https://${deployment.domainName}/protocol/`;
  }

  try {
    const result = await cfn.send(
      new DescribeStacksCommand({
        StackName: `${stackPrefix}-DataspaceConnectorSharedInfraStack`,
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
