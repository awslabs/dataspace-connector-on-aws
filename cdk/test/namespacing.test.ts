// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ConnectorStateTable } from "../lib/constructs/connector-state-table";

/** Synthesizes a stack containing only the state table for the given deployment name. */
function templateFor(deploymentName: string): Template {
  const stack = new Stack(new App(), "TestStack");
  new ConnectorStateTable(stack, "State", `${deploymentName}-connector-state`);
  return Template.fromStack(stack);
}

describe("ConnectorStateTable namespacing (synthesized template)", () => {
  test("table name carries the deployment name prefix", () => {
    templateFor("coexist-test").hasResourceProperties(
      "AWS::DynamoDB::GlobalTable",
      { TableName: "coexist-test-connector-state" },
    );
  });

  test("default deployment name yields the default-prefixed table", () => {
    templateFor("DataspaceConnector").hasResourceProperties(
      "AWS::DynamoDB::GlobalTable",
      { TableName: "DataspaceConnector-connector-state" },
    );
  });

  test("the state table is retained on stack deletion", () => {
    templateFor("dep").hasResource("AWS::DynamoDB::GlobalTable", {
      DeletionPolicy: "Retain",
    });
  });
});
