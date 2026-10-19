// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { SecurityGroup, Vpc } from "aws-cdk-lib/aws-ec2";
import { Cluster } from "aws-cdk-lib/aws-ecs";

import { BasyxStack } from "../lib/basyx/basyx-stack";
import { StateRemovalPolicy } from "../lib/config/config";

const env = { account: "111111111111", region: "eu-central-1" };

function synth(stateRemovalPolicy: StateRemovalPolicy = "RETAIN"): Template {
  const app = new App();
  const infra = new Stack(app, "Infra", { env });
  const vpc = new Vpc(infra, "Vpc", { maxAzs: 2 });
  const stack = new BasyxStack(app, "BaSyx", {
    env,
    bpnl: "BPNL00000007J65N",
    entry: { enabled: true, services: ["dtr", "submodelRepository"] },
    dtrConnectorId: "dtr1",
    deploymentName: "DataspaceConnector",
    profile: "development",
    stateRemovalPolicy,
    vpc,
    cluster: new Cluster(infra, "Cluster", { vpc }),
    dataPlaneSecurityGroup: new SecurityGroup(infra, "DataPlaneSg", { vpc }),
  });
  return Template.fromStack(stack);
}

const retained = synth();

test.each([
  ["RETAIN", "Retain", true],
  ["DESTROY", "Delete", false],
] as const)(
  "%s: cluster and its credentials secret follow the policy",
  (policy, deletionPolicy, deletionProtection) => {
    const t = policy === "RETAIN" ? retained : synth(policy);
    t.hasResource("AWS::RDS::DBCluster", {
      DeletionPolicy: deletionPolicy,
      Properties: Match.objectLike({ DeletionProtection: deletionProtection }),
    });
    t.hasResource("AWS::SecretsManager::Secret", {
      DeletionPolicy: deletionPolicy,
      Properties: Match.objectLike({ GenerateSecretString: Match.anyValue() }),
    });
  },
);

test("only the data plane reaches BaSyx, only BaSyx reaches Aurora", () => {
  const basyxSg = Object.entries(
    retained.findResources("AWS::EC2::SecurityGroup"),
  ).find(([id]) => id.startsWith("BasyxSecurityGroup"))![1];
  expect(basyxSg.Properties.SecurityGroupIngress).toEqual([
    expect.objectContaining({
      FromPort: 5004,
      SourceSecurityGroupId: { "Fn::ImportValue": expect.any(String) },
    }),
  ]);
  const ingress = Object.values(
    retained.findResources("AWS::EC2::SecurityGroupIngress"),
  );
  expect(ingress).toHaveLength(1);
  expect(ingress[0].Properties.FromPort).toBe(5432);
  expect(
    JSON.stringify(retained.findResources("AWS::EC2::SecurityGroup")),
  ).not.toContain('"IpProtocol":"-1"');
});

test("runtimes start only after security files, database and migration", () => {
  type Container = { Name: string; DependsOn?: { ContainerName: string }[] };
  const deps = (task: Container[], name: string) =>
    (task.find((c) => c.Name === name)?.DependsOn ?? []).map(
      (d) => d.ContainerName,
    );
  const tasks = Object.values(
    retained.findResources("AWS::ECS::TaskDefinition"),
  ).map((td) => td.Properties.ContainerDefinitions as Container[]);
  const dtr = tasks.find((t) => t.some((c) => c.Name === "dtr"))!;
  const smrepo = tasks.find((t) => t.some((c) => c.Name === "smrepo"))!;
  expect(deps(dtr, "dtr")).toEqual(["write-security-files", "migrate"]);
  expect(deps(dtr, "migrate")).toEqual([]);
  expect(deps(smrepo, "smrepo")).toEqual(["write-security-files", "migrate"]);
  expect(deps(smrepo, "migrate")).toEqual(["create-database"]);
});

test("services wait for the Aurora writer instance", () => {
  const [writer] = Object.keys(retained.findResources("AWS::RDS::DBInstance"));
  for (const svc of Object.values(
    retained.findResources("AWS::ECS::Service"),
  )) {
    expect(svc.DependsOn).toContain(writer);
  }
});
