// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_DEPLOYMENT_NAME,
  DeploymentYaml,
  ConnectorYaml,
  connectorPriority,
  deriveAdminSecretName,
  deriveConnectorTableName,
  deriveSecretPrefix,
  isIdentityComplete,
  resolveConnectorIdentity,
  resolveDeploymentName,
  toEdcIamEnvVars,
  toPrincipals,
  toRemovalPolicy,
  validateConnectorId,
  validateDeploymentName,
  PortalIdentity,
} from "../lib/config/config";
import { RemovalPolicy } from "aws-cdk-lib";

const completeIdentity: PortalIdentity = {
  trustedIssuer: "did:web:issuer",
  stsOauthTokenUrl: "https://token",
  stsDimUrl: "https://dim",
  participantId: "BPNL00000000AAAA",
  dcpId: "did:web:dcp",
  didResolver: "https://bdrs",
};

describe("validateConnectorId", () => {
  test.each(["ab", "a1", "a-b-c", "a".repeat(60)])("accepts %s", (id) => {
    expect(() => validateConnectorId(id)).not.toThrow();
  });

  // Contract: 2-60 chars, lowercase alphanumeric + hyphen, no leading/trailing hyphen.
  test.each([
    ["a", "single character below the 2-char minimum"],
    ["A", "uppercase"],
    ["-ab", "leading hyphen"],
    ["ab-", "trailing hyphen"],
    ["a_b", "underscore"],
    ["", "empty"],
    ["a".repeat(61), "exceeds 60 chars"],
  ])("rejects %s (%s)", (id) => {
    expect(() => validateConnectorId(id)).toThrow();
  });
});

describe("validateDeploymentName", () => {
  test.each(["DataspaceConnector", "a", "coexist-test", "A".repeat(41)])(
    "accepts %s",
    (name) => {
      expect(() => validateDeploymentName(name)).not.toThrow();
    },
  );

  test.each([
    ["-x", "leading hyphen"],
    ["", "empty"],
    ["a b", "space"],
    ["a_b", "underscore"],
    ["a".repeat(42), "exceeds 41 chars"],
  ])("rejects %s (%s)", (name) => {
    expect(() => validateDeploymentName(name)).toThrow();
  });
});

describe("resolveDeploymentName", () => {
  test("returns the default when unset", () => {
    expect(resolveDeploymentName({} as never)).toBe(DEFAULT_DEPLOYMENT_NAME);
    expect(DEFAULT_DEPLOYMENT_NAME).toBe("DataspaceConnector");
  });

  test("returns the configured value", () => {
    expect(
      resolveDeploymentName({ deploymentName: "coexist-test" } as never),
    ).toBe("coexist-test");
  });
});

describe("name derivation (deploymentName isolation)", () => {
  test("admin secret is namespaced per tenant", () => {
    expect(deriveAdminSecretName("coexist-test", "BPNL123")).toBe(
      "coexist-test/portal-admin/BPNL123",
    );
  });

  test("connector secret prefix is namespaced", () => {
    expect(deriveSecretPrefix("coexist-test", "alpha")).toBe(
      "coexist-test/alpha/",
    );
  });

  test("connector table name is namespaced", () => {
    expect(deriveConnectorTableName("coexist-test", "alpha")).toBe(
      "coexist-test-alpha",
    );
  });

  test("two deployments never collide on the same connectorId", () => {
    const a = deriveConnectorTableName("depA", "alpha");
    const b = deriveConnectorTableName("depB", "alpha");
    expect(a).not.toBe(b);
  });
});

describe("resolveConnectorIdentity", () => {
  const deployment = {
    portal: {
      identity: { participantId: "BPNL-DEFAULT", dcpId: "did:default" },
    },
  } as unknown as DeploymentYaml;

  test("connector override wins field by field", () => {
    const connector = {
      portal: { identity: { participantId: "BPNL-OVERRIDE" } },
    } as unknown as ConnectorYaml;
    const merged = resolveConnectorIdentity(deployment, connector);
    expect(merged.participantId).toBe("BPNL-OVERRIDE");
    // Non-overridden fields fall back to the deployment default.
    expect(merged.dcpId).toBe("did:default");
  });

  test("falls back entirely to the deployment default when no override", () => {
    const connector = {} as unknown as ConnectorYaml;
    expect(resolveConnectorIdentity(deployment, connector)).toEqual({
      participantId: "BPNL-DEFAULT",
      dcpId: "did:default",
    });
  });

  test("empty when neither side defines identity", () => {
    const bare = { portal: {} } as unknown as DeploymentYaml;
    expect(
      resolveConnectorIdentity(bare, {} as unknown as ConnectorYaml),
    ).toEqual({});
  });
});

describe("isIdentityComplete", () => {
  test("true when all required fields are present", () => {
    expect(isIdentityComplete(completeIdentity)).toBe(true);
  });

  test("false when a field is missing", () => {
    const { didResolver, ...partial } = completeIdentity;
    void didResolver;
    expect(isIdentityComplete(partial)).toBe(false);
  });

  test("false when a field is an empty string", () => {
    expect(isIdentityComplete({ ...completeIdentity, participantId: "" })).toBe(
      false,
    );
  });
});

describe("connectorPriority", () => {
  test("is deterministic for the same id", () => {
    expect(connectorPriority("alpha")).toBe(connectorPriority("alpha"));
  });

  test("stays within the ALB listener rule range 1..49999", () => {
    for (const id of [
      "alpha",
      "bravo",
      "a-very-long-connector-id-value",
      "z9",
    ]) {
      const p = connectorPriority(id);
      expect(p).toBeGreaterThanOrEqual(1);
      expect(p).toBeLessThanOrEqual(49999);
    }
  });
});

describe("toEdcIamEnvVars", () => {
  test("maps identity fields to EDC container env var keys", () => {
    const env = toEdcIamEnvVars({
      ...completeIdentity,
      stsOauthClientId: "client-1",
    });
    expect(env["tractusx.edc.participant.bpn"]).toBe("BPNL00000000AAAA");
    expect(env["edc.iam.sts.oauth.client.id"]).toBe("client-1");
    expect(env["edc.iam.trusted-issuer.issuer-1.id"]).toBe("did:web:issuer");
  });
});

describe("toRemovalPolicy", () => {
  test("maps RETAIN and DESTROY", () => {
    expect(toRemovalPolicy("RETAIN")).toBe(RemovalPolicy.RETAIN);
    expect(toRemovalPolicy("DESTROY")).toBe(RemovalPolicy.DESTROY);
  });
});

describe("toPrincipals", () => {
  test("returns an empty array for null/undefined", () => {
    expect(toPrincipals(undefined)).toEqual([]);
    expect(toPrincipals(null)).toEqual([]);
  });

  test("wraps each ARN as a principal", () => {
    expect(toPrincipals(["arn:aws:iam::111122223333:role/A"])).toHaveLength(1);
  });
});
