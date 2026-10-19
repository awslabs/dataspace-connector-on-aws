// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { join } from "path";

import { BasyxStack } from "../lib/basyx/basyx-stack";
import {
  basyxStackName,
  DeploymentConfig,
  loadDeploymentConfig,
} from "../lib/config/config";
import { DeploymentStage } from "../lib/deployment-stage";
import { ResolvedEdcIam } from "../lib/portal/provision-output";

const BPNL = "BPNL00000007J65N";
const CONFIG_PATH = join(__dirname, "..", "config-templates");
const env = { account: "111111111111", region: "eu-central-1" };

const edcIam: ResolvedEdcIam = {
  example: {
    trustedIssuer: "did:web:issuer",
    stsOauthTokenUrl: "https://sts.example/token",
    stsOauthClientId: "client",
    stsDimUrl: "https://dim.example",
    participantId: BPNL,
    dcpId: "did:web:dcp",
    didResolver: "https://bdrs.example",
  },
};

function config(basyx: boolean): DeploymentConfig {
  const loaded = loadDeploymentConfig(CONFIG_PATH);
  return {
    ...loaded,
    deployment: {
      ...loaded.deployment,
      portal: {
        ...loaded.deployment.portal,
        identity: { ...loaded.deployment.portal.identity, participantId: BPNL },
      },
      ...(basyx
        ? { basyx: { [BPNL]: { enabled: true, services: ["dtr"] } } }
        : {}),
    },
  };
}

function stage(basyx: boolean, resolved: ResolvedEdcIam): DeploymentStage {
  const host = new Stack(new App(), "Host", { env });
  return new DeploymentStage(host, "DataspaceConnector", {
    config: config(basyx),
    resolvedEdcIam: resolved,
    activeBpnls: [BPNL],
    deploymentName: "DataspaceConnector",
    env,
  });
}

const basyxStacks = (s: DeploymentStage) =>
  s.node.children.filter((c): c is BasyxStack => c instanceof BasyxStack);

describe("DeploymentStage BaSyx wiring", () => {
  test("no basyx block: no BaSyx stack", () => {
    expect(basyxStacks(stage(false, edcIam))).toHaveLength(0);
  });

  test("enabled entry with its dtrConnector deployed: one BaSyx stack", () => {
    const s = stage(true, edcIam);
    const [basyx] = basyxStacks(s);
    expect(basyx.stackName).toBe(basyxStackName("DataspaceConnector", BPNL));
    // Dependencies come from cross-stack references, which resolve at synth.
    s.synth();
    expect(basyx.dependencies.map((d) => d.node.id).sort()).toEqual([
      "Connector-example",
      "SharedInfra",
    ]);
  });

  test("dtrConnector not deployed this run: BaSyx skipped", () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    expect(basyxStacks(stage(true, {}))).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(
      `basyx ${BPNL}: dtrConnector example not deployed yet, skipping`,
    );
    log.mockRestore();
  });

  test("two BPNLs: every fixed name differs", () => {
    const OTHER = "BPNL00000000TWO2";
    const base = config(false);
    const second = {
      ...base.connectors[0],
      connectorId: "second",
      portal: { identity: { participantId: OTHER } },
    };
    const host = new Stack(new App(), "Host", { env });
    const s = new DeploymentStage(host, "DataspaceConnector", {
      config: {
        connectors: [base.connectors[0], second],
        deployment: {
          ...base.deployment,
          basyx: {
            [BPNL]: { enabled: true, services: ["dtr", "submodelRepository"] },
            [OTHER]: { enabled: true, services: ["dtr", "submodelRepository"] },
          },
        },
      },
      resolvedEdcIam: {
        ...edcIam,
        second: { ...edcIam.example, participantId: OTHER },
      },
      activeBpnls: [BPNL, OTHER],
      deploymentName: "DataspaceConnector",
      env,
    });
    const names = basyxStacks(s).map((b) => {
      const t = Template.fromStack(b);
      const props = (type: string, key: string) =>
        Object.values(t.findResources(type)).map((r) => r.Properties[key]);
      return [
        b.stackName,
        ...props("AWS::RDS::DBCluster", "DBClusterIdentifier"),
        ...props("AWS::Cognito::UserPoolDomain", "Domain"),
        ...props("AWS::ServiceDiscovery::PrivateDnsNamespace", "Name"),
        ...props("AWS::SecretsManager::Secret", "Name").filter(Boolean),
      ];
    });
    expect(names).toHaveLength(2);
    expect(names[0]).toHaveLength(5);
    expect(names[0].filter((n) => names[1].includes(n))).toEqual([]);
  });
});
