// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "fs";
import yaml from "js-yaml";

type Spec = { paths: Record<string, Record<string, unknown>> };

const spec = yaml.load(
  fs.readFileSync("./api/data-plane-api.yaml", { encoding: "utf-8" }),
) as Spec;

describe("data plane API", () => {
  // Multi-segment paths such as DTR lookup/shells must reach the data plane.
  test("proxies every method on a greedy path", () => {
    const route = spec.paths["/{connectorId}/{any+}"];
    const method = route["x-amazon-apigateway-any-method"] as {
      "x-amazon-apigateway-integration": {
        requestParameters: Record<string, string>;
      };
    };
    expect(
      method["x-amazon-apigateway-integration"].requestParameters[
        "integration.request.path.any"
      ],
    ).toBe("method.request.path.any");
  });
});
