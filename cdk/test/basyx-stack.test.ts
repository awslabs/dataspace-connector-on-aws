// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import { Cluster } from "aws-cdk-lib/aws-ecs";

import { BasyxStack } from "../lib/basyx/basyx-stack";
import { StateRemovalPolicy } from "../lib/config/config";

const env = { account: "111111111111", region: "eu-central-1" };
const ALB_SG = "sg-0123456789abcdef0";

function synth(stateRemovalPolicy: StateRemovalPolicy = "RETAIN"): Template {
  const app = new App();
  const infra = new Stack(app, "Infra", { env });
  const vpc = new Vpc(infra, "Vpc", { maxAzs: 2 });
  const stack = new BasyxStack(app, "BaSyx", {
    env,
    bpnl: "BPNL00000000DEMO",
    entry: {
      services: ["dtr", "submodelRepository"],
      dtrConnector: "dtr1",
      profile: "development",
      stateRemovalPolicy,
    },
    deploymentName: "DataspaceConnector",
    vpc,
    cluster: new Cluster(infra, "Cluster", { vpc }),
    alb: {
      dnsName: "alb.internal",
      securityGroupId: ALB_SG,
      managementListenerArn: "arn:listener/8182",
      readListenerArn: "arn:listener/5004",
    },
    dtrOfferServiceToken:
      "arn:aws:lambda:eu-central-1:111111111111:function:dtr-offer",
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

test("only the ALB reaches BaSyx", () => {
  const ingress = Object.values(
    retained.findResources("AWS::EC2::SecurityGroupIngress"),
  ).map((r) => r.Properties);
  expect(ingress).toHaveLength(2);
  expect(ingress).toContainEqual(
    expect.objectContaining({ FromPort: 5004, SourceSecurityGroupId: ALB_SG }),
  );
  expect(ingress).toContainEqual(expect.objectContaining({ FromPort: 5432 }));
  expect(
    JSON.stringify(retained.findResources("AWS::EC2::SecurityGroup")),
  ).not.toContain('"IpProtocol":"-1"');
});

test("each service is routed under its context path on both listeners", () => {
  const rules = Object.values(
    retained.findResources("AWS::ElasticLoadBalancingV2::ListenerRule"),
  ).map((r) => r.Properties);
  const paths = (arn: string) =>
    rules
      .filter((r) => r.ListenerArn === arn)
      .map((r) => r.Conditions[0].PathPatternConfig.Values[0])
      .sort();
  const expected = [
    "/basyx/BPNL00000000DEMO/dtr/api/v3/*",
    "/basyx/BPNL00000000DEMO/smrepo/*",
  ];
  expect(paths("arn:listener/8182")).toEqual(expected);
  expect(paths("arn:listener/5004")).toEqual(expected);
  expect(
    retained.findResources("AWS::ServiceDiscovery::PrivateDnsNamespace"),
  ).toEqual({});
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

test("BaSyx images come from ECR, not Docker Hub", () => {
  const images = Object.values(
    retained.findResources("AWS::ECS::TaskDefinition"),
  ).flatMap((td) =>
    (td.Properties.ContainerDefinitions as { Image: unknown }[]).map((c) =>
      JSON.stringify(c.Image),
    ),
  );
  expect(images.some((i) => i.includes("eclipsebasyx"))).toBe(false);
  expect(images.filter((i) => i.includes(".dkr.ecr."))).toHaveLength(4);
});

test("one log group per task, one stream prefix per container", () => {
  expect(
    Object.keys(retained.findResources("AWS::Logs::LogGroup")),
  ).toHaveLength(2);
});

test("a deploymentName that breaks the Cognito prefix rules fails synth", () => {
  const app = new App();
  const infra = new Stack(app, "Infra", { env });
  const vpc = new Vpc(infra, "Vpc", { maxAzs: 2 });
  expect(
    () =>
      new BasyxStack(app, "BaSyx", {
        env,
        bpnl: "BPNL00000000DEMO",
        entry: {
          services: ["dtr"],
          dtrConnector: "dtr1",
          profile: "development",
          stateRemovalPolicy: "RETAIN",
        },
        deploymentName: "AmazonConnector",
        vpc,
        cluster: new Cluster(infra, "Cluster", { vpc }),
        alb: {
          dnsName: "alb.internal",
          securityGroupId: ALB_SG,
          managementListenerArn: "arn:listener/8182",
          readListenerArn: "arn:listener/5004",
        },
        dtrOfferServiceToken:
          "arn:aws:lambda:eu-central-1:111111111111:function:dtr-offer",
      }),
  ).toThrow('contains the reserved word "amazon"');
});

test("services wait for the Aurora writer instance", () => {
  const [writer] = Object.keys(retained.findResources("AWS::RDS::DBInstance"));
  for (const svc of Object.values(
    retained.findResources("AWS::ECS::Service"),
  )) {
    expect(svc.DependsOn).toContain(writer);
  }
});
