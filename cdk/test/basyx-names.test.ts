// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  basyxClientSecretAlias,
  basyxContextPath,
  cognitoDomainPrefix,
  cognitoTokenUrl,
  dtrUrl,
  READ_SCOPE,
  validateCognitoDomainPrefix,
} from "../lib/basyx/names";

const BPNL = "BPNL00000000DEMO";

describe("BaSyx names", () => {
  test("context paths, domain prefix, URLs and secret alias", () => {
    expect(basyxContextPath(BPNL, "dtr")).toBe(`/basyx/${BPNL}/dtr/api/v3`);
    expect(basyxContextPath(BPNL, "submodelRepository")).toBe(
      `/basyx/${BPNL}/smrepo`,
    );
    expect(dtrUrl("alb.internal", BPNL)).toBe(
      `http://alb.internal:5004/basyx/${BPNL}/dtr/api/v3`,
    );
    const prefix = cognitoDomainPrefix("DataspaceConnector", BPNL);
    expect(prefix).toBe("dataspaceconnector-basyx-bpnl00000000demo");
    expect(cognitoTokenUrl(prefix, "eu-central-1")).toBe(
      "https://dataspaceconnector-basyx-bpnl00000000demo.auth.eu-central-1.amazoncognito.com/oauth2/token",
    );
    expect(basyxClientSecretAlias("DataspaceConnector", "dtr1")).toBe(
      "DataspaceConnector/dtr1/basyx.dtr.oauth.client.secret",
    );
    expect(READ_SCOPE).toBe("dataspace-connector-basyx/read");
  });

  test("default deployment name passes validation", () => {
    expect(() =>
      validateCognitoDomainPrefix("DataspaceConnector", BPNL),
    ).not.toThrow();
  });

  test("a 40-char deployment name fits, 41 does not", () => {
    expect(() =>
      validateCognitoDomainPrefix("d".repeat(40), BPNL),
    ).not.toThrow();
    expect(() => validateCognitoDomainPrefix("d".repeat(41), BPNL)).toThrow(
      `basyx.${BPNL}: Cognito domain prefix "${"d".repeat(41)}-basyx-bpnl00000000demo" is 64 characters (max 63); use a deploymentName of at most 40 characters`,
    );
  });

  test.each(["aws", "amazon", "cognito"])("rejects reserved word %s", (w) => {
    expect(() => validateCognitoDomainPrefix(`my-${w}-dep`, BPNL)).toThrow(
      `contains the reserved word "${w}"`,
    );
  });

  test("reserved word inside the BPNL is caught too", () => {
    expect(() =>
      validateCognitoDomainPrefix("dep", "BPNL0000000AWS01"),
    ).toThrow('contains the reserved word "aws"');
  });
});
