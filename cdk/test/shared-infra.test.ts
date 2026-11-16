// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { readFileSync } from "fs";
import { join } from "path";

import { loadDeploymentConfig, PersistenceType } from "../lib/config/config";
import { SharedInfraStack } from "../lib/shared-infra-stack";

const CONFIG_PATH = join(__dirname, "..", "config-templates");

describe("SharedInfra ALB security group", () => {
  const stack = new SharedInfraStack(new App(), "SharedInfra", {
    config: loadDeploymentConfig(CONFIG_PATH).deployment,
    deploymentName: "DataspaceConnector",
    persistenceTypes: new Set<PersistenceType>(["dynamodb"]),
  });
  const template = Template.fromStack(stack);
  const ingress = Object.values(
    template.findResources("AWS::EC2::SecurityGroupIngress"),
  ).map((r) => r.Properties);
  const [albSgId] = Object.keys(
    template.findResources("AWS::EC2::SecurityGroup", {
      Properties: {
        GroupDescription: Match.stringLikeRegexp("ALB communication"),
      },
    }),
  );
  const [taskSgId] = Object.keys(
    template.findResources("AWS::EC2::SecurityGroup", {
      Properties: { GroupDescription: Match.stringLikeRegexp("EDC tasks") },
    }),
  );
  const portsFrom = (sourceId: string) =>
    ingress
      .filter((p) => p.SourceSecurityGroupId?.["Fn::GetAtt"]?.[0] === sourceId)
      .map((p) => p.FromPort)
      .sort();

  test("admits no CIDR range", () => {
    const sg = template.findResources("AWS::EC2::SecurityGroup");
    expect(sg[albSgId].Properties.SecurityGroupIngress).toBeUndefined();
    expect(ingress.every((p) => p.CidrIp === undefined)).toBe(true);
  });

  test("admits the VPC link on the API Gateway ports only", () => {
    expect(portsFrom(albSgId)).toEqual([8181, 8182, 8185, 8282, 9181]);
  });

  test("admits EDC tasks on the control ports and the BaSyx read port only", () => {
    expect(portsFrom(taskSgId)).toEqual([5004, 9191, 9192]);
  });
});

describe("SharedInfra API stages", () => {
  const methodSettings = (logLevel?: "INFO" | "DEBUG") => {
    const { deployment } = loadDeploymentConfig(CONFIG_PATH);
    const stack = new SharedInfraStack(new App(), "SharedInfra", {
      config: { ...deployment, logLevel },
      deploymentName: "DataspaceConnector",
      persistenceTypes: new Set<PersistenceType>(["dynamodb"]),
    });
    return Object.values(
      Template.fromStack(stack).findResources("AWS::ApiGateway::Stage"),
    ).map((r) => r.Properties.MethodSettings[0]);
  };

  test("trace request data only at DEBUG or TRACE, with no throttling override", () => {
    for (const s of methodSettings("INFO")) {
      expect(s.DataTraceEnabled).toBe(false);
      expect(s.ThrottlingBurstLimit).toBeUndefined();
      expect(s.ThrottlingRateLimit).toBeUndefined();
    }
    for (const s of methodSettings("DEBUG")) {
      expect(s.DataTraceEnabled).toBe(true);
    }
  });
});

describe("SharedInfra runtime images", () => {
  const synthesize = (persistenceTypes: PersistenceType[]) => {
    const app = new App();
    const stack = new SharedInfraStack(app, "SharedInfra", {
      config: loadDeploymentConfig(CONFIG_PATH).deployment,
      deploymentName: "DataspaceConnector",
      persistenceTypes: new Set(persistenceTypes),
    });
    const manifest = JSON.parse(
      readFileSync(
        join(app.synth().directory, `${stack.artifactId}.assets.json`),
        "utf8",
      ),
    );
    // Docker build args by asset display name.
    const buildArgs: Record<string, Record<string, string> | undefined> =
      Object.fromEntries(
        Object.values<{
          displayName: string;
          source: { dockerBuildArgs?: Record<string, string> };
        }>(manifest.dockerImages).map((i) => [
          i.displayName,
          i.source.dockerBuildArgs,
        ]),
      );
    return { stack, buildArgs };
  };

  test("dynamodb only: one image per plane, no JAR build arg", () => {
    const { stack, buildArgs } = synthesize(["dynamodb"]);
    expect(buildArgs).toEqual({
      ControlPlaneImage: undefined,
      DataPlaneImage: undefined,
    });
    expect(Object.keys(stack.controlPlaneImages)).toEqual(["dynamodb"]);
    expect(Object.keys(stack.dataPlaneImages)).toEqual(["dynamodb"]);
  });

  test("dynamodb and aurora: four images, only the aurora ones carry JAR", () => {
    const { stack, buildArgs } = synthesize(["dynamodb", "aurora"]);
    expect(buildArgs).toEqual({
      ControlPlaneImage: undefined,
      ControlPlanePostgresImage: { JAR: "control-plane-postgres.jar" },
      DataPlaneImage: undefined,
      DataPlanePostgresImage: { JAR: "data-plane-postgres.jar" },
    });
    // Variants of one plane build from the same directory but hash apart.
    expect(stack.controlPlaneImages.dynamodb!.assetHash).not.toBe(
      stack.controlPlaneImages.aurora!.assetHash,
    );
    expect(stack.dataPlaneImages.dynamodb!.assetHash).not.toBe(
      stack.dataPlaneImages.aurora!.assetHash,
    );
  });

  test("aurora only: two images, both with the PostgreSQL jar", () => {
    const { stack, buildArgs } = synthesize(["aurora"]);
    expect(buildArgs).toEqual({
      ControlPlanePostgresImage: { JAR: "control-plane-postgres.jar" },
      DataPlanePostgresImage: { JAR: "data-plane-postgres.jar" },
    });
    expect(Object.keys(stack.controlPlaneImages)).toEqual(["aurora"]);
    expect(Object.keys(stack.dataPlaneImages)).toEqual(["aurora"]);
  });
});
