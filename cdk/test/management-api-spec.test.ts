// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "fs";
import yaml from "js-yaml";

type Method = {
  "x-amazon-apigateway-auth": { type: string };
  "x-amazon-apigateway-integration": {
    uri: string;
    requestParameters: Record<string, string>;
  };
};
type Spec = { paths: Record<string, Record<string, Method>> };

const spec = yaml.load(
  fs.readFileSync("./api/management-api.yaml", { encoding: "utf-8" }),
) as Spec;

describe("management API BaSyx route", () => {
  const method = spec.paths["/basyx/{any+}"]["x-amazon-apigateway-any-method"];
  const integration = method["x-amazon-apigateway-integration"];

  test("requires IAM like every other management route", () => {
    expect(method["x-amazon-apigateway-auth"].type).toBe("AWS_IAM");
  });

  test("forwards the full path and the Cognito token to the ALB", () => {
    expect(integration.uri).toBe("http://${loadBalancerDnsName}/basyx/{any}");
    expect(integration.requestParameters).toEqual({
      "integration.request.path.any": "method.request.path.any",
      "integration.request.header.Authorization":
        "method.request.header.X-BaSyx-Authorization",
    });
  });
});
