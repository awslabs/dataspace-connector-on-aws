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
import { ConnectorStack } from "../lib/connector-stack";
import { DeploymentStage } from "../lib/deployment-stage";

const BPNL = "BPNL00000007J65N";
const CONFIG_PATH = join(__dirname, "..", "config-templates");
const env = { account: "111111111111", region: "eu-central-1" };

function config(basyx: boolean): DeploymentConfig {
  const loaded = loadDeploymentConfig(CONFIG_PATH);
  return {
    ...loaded,
    deployment: {
      ...loaded.deployment,
      portal: { ...loaded.deployment.portal, bpnl: BPNL },
      ...(basyx ? { basyx: { [BPNL]: { services: ["dtr"] } } } : {}),
    },
  };
}

function stage(basyx: boolean): DeploymentStage {
  const host = new Stack(new App(), "Host", { env });
  return new DeploymentStage(host, "DataspaceConnector", {
    config: config(basyx),
    deploymentName: "DataspaceConnector",
    env,
  });
}

const connectorStacks = (s: DeploymentStage) =>
  s.node.children.filter(
    (c): c is ConnectorStack => c instanceof ConnectorStack,
  );

const basyxStacks = (s: DeploymentStage) =>
  s.node.children.filter((c): c is BasyxStack => c instanceof BasyxStack);

describe("DeploymentStage BaSyx wiring", () => {
  test("no basyx block: no BaSyx stack", () => {
    expect(basyxStacks(stage(false))).toHaveLength(0);
  });

  test("basyx entry: one BaSyx stack, depending on SharedInfra only", () => {
    const s = stage(true);
    const [basyx] = basyxStacks(s);
    expect(basyx.stackName).toBe(basyxStackName("DataspaceConnector", BPNL));
    // Dependencies come from cross-stack references, which resolve at synth.
    s.synth();
    expect(basyx.dependencies.map((d) => d.node.id)).toEqual(["SharedInfra"]);
  });

  test("basyx profile overrides the deployment profile", () => {
    const base = config(false);
    const backupRetention = (profile?: "production") => {
      const host = new Stack(new App(), "Host", { env });
      const s = new DeploymentStage(host, "DataspaceConnector", {
        config: {
          ...base,
          deployment: {
            ...base.deployment,
            profile: "development",
            basyx: { [BPNL]: { services: ["dtr"], profile } },
          },
        },
        deploymentName: "DataspaceConnector",
        env,
      });
      const [cluster] = Object.values(
        Template.fromStack(basyxStacks(s)[0]).findResources(
          "AWS::RDS::DBCluster",
        ),
      );
      return cluster.Properties.BackupRetentionPeriod;
    };
    expect(backupRetention()).toBe(1);
    expect(backupRetention("production")).toBe(7);
  });

  test("two BPNLs: every fixed name differs", () => {
    const OTHER = "BPNL00000000TWO2";
    const base = config(false);
    const second = {
      ...base.connectors[0],
      connectorId: "second",
      bpnl: OTHER,
    };
    const host = new Stack(new App(), "Host", { env });
    const s = new DeploymentStage(host, "DataspaceConnector", {
      config: {
        connectors: [base.connectors[0], second],
        deployment: {
          ...base.deployment,
          basyx: {
            [BPNL]: { services: ["dtr", "submodelRepository"] },
            [OTHER]: { services: ["dtr", "submodelRepository"] },
          },
        },
      },
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
        ...props("AWS::SecretsManager::Secret", "Name").filter(Boolean),
        ...Object.values(
          t.findResources("AWS::ElasticLoadBalancingV2::ListenerRule"),
        ).flatMap((r) => [
          r.Properties.Priority,
          r.Properties.Conditions[0].PathPatternConfig.Values[0],
        ]),
      ];
    });
    expect(names).toHaveLength(2);
    // 5 names, plus priority and path of 2 services on 2 listeners each.
    expect(names[0]).toHaveLength(13);
    expect(names[0].filter((n) => names[1].includes(n))).toEqual([]);
  });
});

describe("DeploymentStage portal lifecycle", () => {
  const s = stage(false);
  const [connector] = connectorStacks(s);
  const template = Template.fromStack(connector);

  test("every connector deploys, with one PortalConnector resource", () => {
    expect(connectorStacks(s)).toHaveLength(1);
    template.resourceCountIs("Custom::PortalConnector", 1);
    template.hasResourceProperties("Custom::PortalConnector", {
      Environment: "beta",
      Bpnl: BPNL,
      ConnectorName: "example",
      TechnicalUserName: "DataspaceConnector-example",
      AdminSecretName: `DataspaceConnector/portal-admin/${BPNL}`,
    });
  });

  test("EDC identity: derived values and the technical user's attributes", () => {
    const [taskDef] = Object.values(
      template.findResources("AWS::ECS::TaskDefinition"),
    );
    const vars = Object.fromEntries(
      taskDef.Properties.ContainerDefinitions[0].Environment.map(
        (e: { Name: string; Value: unknown }) => [e.Name, e.Value],
      ),
    );
    expect(vars["tractusx.edc.participant.bpn"]).toBe(BPNL);
    expect(vars["edc.iam.issuer.id"]).toBe(
      `did:web:portal-backend.beta.cofinity-x.com:api:administration:staticdata:did:${BPNL}`,
    );
    expect(vars["edc.iam.sts.oauth.client.id"]).toEqual({
      "Fn::GetAtt": [expect.stringMatching(/^PortalConnector/), "ClientId"],
    });
    expect(vars["edc.iam.sts.oauth.token.url"]).toEqual({
      "Fn::GetAtt": [
        expect.stringMatching(/^PortalConnector/),
        "StsOauthTokenUrl",
      ],
    });
  });
});
