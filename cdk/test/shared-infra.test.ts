// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { join } from "path";

import { loadDeploymentConfig } from "../lib/config/config";
import { SharedInfraStack } from "../lib/shared-infra-stack";

const CONFIG_PATH = join(__dirname, "..", "config-templates");

describe("SharedInfra ALB security group", () => {
  const stack = new SharedInfraStack(new App(), "SharedInfra", {
    config: loadDeploymentConfig(CONFIG_PATH).deployment,
    adminBpnls: [],
    deploymentName: "DataspaceConnector",
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
    expect(portsFrom(albSgId)).toEqual([8181, 8182, 8185, 8282]);
  });

  test("admits EDC tasks on the control ports and the BaSyx read port only", () => {
    expect(portsFrom(taskSgId)).toEqual([5004, 9191, 9192]);
  });
});
