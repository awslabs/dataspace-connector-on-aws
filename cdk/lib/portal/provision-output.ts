// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ephemeral intra-Synth handoff from provision to the CDK app.
 *
 * provision runs pre-synth and writes these files under configPath; the app
 * reads them synchronously during synth (CDK construction cannot do async DDB
 * reads mid-synth). Durable cross-run state lives in DynamoDB, not here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { EdcIam } from "../config/config";

const DIR = ".provision-state";
const EDC_IAM_FILE = "edc-iam.json";
const BPNLS_FILE = "active-bpnls.json";

/** Resolved identity per connector (connectorId -> edcIam). Presence gates deployment. */
export type ResolvedEdcIam = Record<string, EdcIam>;

export function writeProvisionOutput(
  configPath: string,
  edcIam: ResolvedEdcIam,
  activeBpnls: string[],
): void {
  const dir = join(configPath, DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, EDC_IAM_FILE),
    JSON.stringify(edcIam, null, 2),
    "utf-8",
  );
  const distinct = [...new Set(activeBpnls)].sort();
  writeFileSync(
    join(dir, BPNLS_FILE),
    JSON.stringify(distinct, null, 2),
    "utf-8",
  );
}

/** Resolved edcIam per connector; empty when provision has not run (bare synth). */
export function readResolvedEdcIam(configPath: string): ResolvedEdcIam {
  const path = join(configPath, DIR, EDC_IAM_FILE);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf-8")) as ResolvedEdcIam)
    : {};
}

/** Union of config BPNLs and live DDB orgKeys; drives SharedInfra admin-secret placeholders. */
export function readActiveBpnls(configPath: string): string[] {
  const path = join(configPath, DIR, BPNLS_FILE);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf-8")) as string[])
    : [];
}
