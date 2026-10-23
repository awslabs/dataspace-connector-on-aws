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
type Spec = {
  "x-amazon-apigateway-request-validator"?: string;
  "x-amazon-apigateway-request-validators"?: Record<string, object>;
  paths: Record<string, Record<string, Method>>;
};

const load = (file: string) =>
  yaml.load(fs.readFileSync(`./api/${file}`, { encoding: "utf-8" })) as Spec;

const spec = load("management-api.yaml");

test.each([
  "management-api.yaml",
  "dsp-api.yaml",
  "observability-api.yaml",
  "data-plane-api.yaml",
])("%s validates request parameters and bodies on every method", (file) => {
  const s = load(file);
  expect(s["x-amazon-apigateway-request-validator"]).toBe("all");
  expect(s["x-amazon-apigateway-request-validators"]).toEqual({
    all: { validateRequestBody: true, validateRequestParameters: true },
  });
});

test.each([
  ["control-plane", "loadBalancerDnsName"],
  ["data-plane", "dataPlaneDefaultAddress"],
])(
  "observability API routes %s health checks to its plane",
  (plane, address) => {
    const paths = load("observability-api.yaml").paths;
    for (const probe of ["health", "liveness", "readiness", "startup"]) {
      const uri =
        paths[`/{connectorId}/${plane}/check/${probe}`].get[
          "x-amazon-apigateway-integration"
        ].uri;
      expect(uri).toBe(
        `http://\${${address}}/{connectorId}/api/check/${probe}`,
      );
    }
  },
);

test("no spec exposes version details or internal control APIs", () => {
  for (const file of [
    "management-api.yaml",
    "dsp-api.yaml",
    "observability-api.yaml",
    "data-plane-api.yaml",
  ]) {
    const paths = Object.keys(load(file).paths).join("\n");
    expect(paths).not.toMatch(
      /\/v1\/version|\/transferprocess\/|\/v1\/dataplanes|\/v1\/dataflows|catalog\/query/,
    );
  }
});

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
