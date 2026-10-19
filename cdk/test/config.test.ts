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
  validateLogLevel,
  PortalIdentity,
} from "../lib/config/config";
import {
  basyxStackName,
  DeploymentConfig,
  enabledBasyx,
  loadDeploymentConfig,
  loadPipelineConfig,
  resolveStateRemovalPolicy,
} from "../lib/config/config";
import { RemovalPolicy } from "aws-cdk-lib";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import * as yaml from "js-yaml";

const completeIdentity: PortalIdentity = {
  trustedIssuer: "did:web:issuer",
  stsOauthTokenUrl: "https://token",
  stsDimUrl: "https://dim",
  participantId: "BPNL00000000AAAA",
  dcpId: "did:web:dcp",
  didResolver: "https://bdrs",
};

describe("validateLogLevel", () => {
  test.each([undefined, "DEBUG", "INFO", "OFF"])("accepts %s", (level) => {
    expect(() => validateLogLevel(level, "test")).not.toThrow();
  });

  test.each(["debug", "VERBOSE", ""])("rejects %s", (level) => {
    expect(() => validateLogLevel(level, "test")).toThrow(/logLevel/);
  });
});

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

// ─── Loader: unknown keys, stateRemovalPolicy, basyx ─────────────────────────

const BPNL = "BPNL00000007J65N";
const OTHER_BPNL = "BPNL00000000BBBB";

const baseDeployment = (): Record<string, unknown> => ({
  profile: "development",
  vpcIpAddresses: "10.0.0.0/20",
  containerInsights: true,
  managementApiPrincipals: [],
  observabilityApiPrincipals: [],
  portal: {
    environment: "beta",
    identity: { ...completeIdentity, participantId: BPNL },
  },
});

const baseConnector = (id: string): Record<string, unknown> => ({
  connectorId: id,
  controlPlaneCpu: 256,
  controlPlaneMemoryLimitMiB: 1024,
  dataPlaneCpu: 256,
  dataPlaneMemoryLimitMiB: 512,
  serviceAccountId: `sa-${id}`,
});

const tempDirs: string[] = [];
afterAll(() =>
  tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true })),
);

/** Writes a config dir; connectors keyed by file suffix (connector-<key>.yaml). */
function writeConfig(
  deployment: Record<string, unknown>,
  connectors: Record<string, Record<string, unknown>>,
  pipeline?: Record<string, unknown>,
): string {
  const dir = mkdtempSync(join(tmpdir(), "config-test-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "connectors"));
  writeFileSync(join(dir, "deployment.yaml"), yaml.dump(deployment));
  for (const [key, body] of Object.entries(connectors)) {
    writeFileSync(
      join(dir, "connectors", `connector-${key}.yaml`),
      yaml.dump(body),
    );
  }
  if (pipeline) writeFileSync(join(dir, "pipeline.yaml"), yaml.dump(pipeline));
  return dir;
}

const withBasyx = (entry: Record<string, unknown>, key = BPNL) => ({
  ...baseDeployment(),
  basyx: { [key]: entry },
});

const otherBpnlConnector = (id: string) => ({
  ...baseConnector(id),
  portal: { identity: { participantId: OTHER_BPNL } },
});

const oneConnector = () => ({ a: baseConnector("aa") });

describe("unknown config keys", () => {
  test("pipeline.yaml top-level key", () => {
    const dir = writeConfig(baseDeployment(), oneConnector(), {
      appRepo: "x/y",
      appVersion: "main",
      configSource: "codecommit",
      approval: true,
    });
    expect(() => loadPipelineConfig(dir)).toThrow(
      "pipeline.yaml: unknown key 'approval'",
    );
  });

  test("deployment.yaml top-level key", () => {
    const dir = writeConfig(
      { ...baseDeployment(), logLevl: "DEBUG" },
      oneConnector(),
    );
    expect(() => loadDeploymentConfig(dir)).toThrow(
      "deployment.yaml: unknown key 'logLevl'",
    );
  });

  test("deployment.yaml nested portal.identity key", () => {
    const d = baseDeployment();
    (d.portal as Record<string, unknown>).identity = {
      ...completeIdentity,
      x: 1,
    };
    const dir = writeConfig(d, oneConnector());
    expect(() => loadDeploymentConfig(dir)).toThrow(
      "deployment.yaml: unknown key 'portal.identity.x'",
    );
  });

  test("deployment.yaml key inside a basyx entry", () => {
    const dir = writeConfig(
      withBasyx({ enabled: true, service: ["dtr"] }),
      oneConnector(),
    );
    expect(() => loadDeploymentConfig(dir)).toThrow(
      `deployment.yaml: unknown key 'basyx.${BPNL}.service'`,
    );
  });

  test("connector file: the old edcStateRemovalPolicy key", () => {
    const dir = writeConfig(baseDeployment(), {
      a: { ...baseConnector("aa"), edcStateRemovalPolicy: "DESTROY" },
    });
    expect(() => loadDeploymentConfig(dir)).toThrow(
      "connectors/connector-a.yaml: unknown key 'edcStateRemovalPolicy'",
    );
  });

  test("connector file nested portal.identity key", () => {
    const dir = writeConfig(baseDeployment(), {
      a: { ...baseConnector("aa"), portal: { identity: { bpn: "x" } } },
    });
    expect(() => loadDeploymentConfig(dir)).toThrow(
      "connectors/connector-a.yaml: unknown key 'portal.identity.bpn'",
    );
  });
});

describe("shipped templates", () => {
  const templates = resolve(__dirname, "../config-templates");
  test("deployment.yaml and connectors load cleanly", () => {
    expect(() => loadDeploymentConfig(templates)).not.toThrow();
  });
  test("pipeline.yaml loads cleanly", () => {
    expect(() => loadPipelineConfig(templates)).not.toThrow();
  });
});

describe("stateRemovalPolicy validation", () => {
  test("deployment value", () => {
    const dir = writeConfig(
      { ...baseDeployment(), stateRemovalPolicy: "KEEP" },
      oneConnector(),
    );
    expect(() => loadDeploymentConfig(dir)).toThrow(
      'deployment.yaml: stateRemovalPolicy must be "RETAIN" or "DESTROY", got "KEEP"',
    );
  });

  test("connector value", () => {
    const dir = writeConfig(baseDeployment(), {
      a: { ...baseConnector("aa"), stateRemovalPolicy: "retain" },
    });
    expect(() => loadDeploymentConfig(dir)).toThrow(
      'connectors/connector-a.yaml: stateRemovalPolicy must be "RETAIN" or "DESTROY", got "retain"',
    );
  });

  test("basyx entry value", () => {
    const dir = writeConfig(
      withBasyx({ enabled: true, services: ["dtr"], stateRemovalPolicy: "X" }),
      oneConnector(),
    );
    expect(() => loadDeploymentConfig(dir)).toThrow(
      `deployment.yaml: basyx.${BPNL}.stateRemovalPolicy must be "RETAIN" or "DESTROY", got "X"`,
    );
  });
});

describe("basyx validation", () => {
  const load = (
    entry: Record<string, unknown>,
    key = BPNL,
    connectors: Record<string, Record<string, unknown>> = oneConnector(),
  ) => loadDeploymentConfig(writeConfig(withBasyx(entry, key), connectors));

  test("invalid BPNL key", () => {
    expect(() => load({ enabled: true, services: ["dtr"] }, "BPNL123")).toThrow(
      "deployment.yaml: basyx key 'BPNL123' is not a valid BPNL",
    );
  });

  test("enabled not boolean", () => {
    expect(() => load({ enabled: "yes", services: ["dtr"] })).toThrow(
      `deployment.yaml: basyx.${BPNL}.enabled must be true or false`,
    );
  });

  test("services empty", () => {
    expect(() => load({ enabled: true, services: [] })).toThrow(
      `deployment.yaml: basyx.${BPNL}.services must be a non-empty list`,
    );
  });

  test("unknown service", () => {
    expect(() => load({ enabled: true, services: ["dtr", "dpp"] })).toThrow(
      `deployment.yaml: basyx.${BPNL}.services: unknown service 'dpp' (allowed: dtr, submodelRepository)`,
    );
  });

  test("services without dtr", () => {
    expect(() =>
      load({ enabled: true, services: ["submodelRepository"] }),
    ).toThrow(`deployment.yaml: basyx.${BPNL}.services must include 'dtr'`);
  });

  test("enabled BPNL without connector", () => {
    expect(() =>
      load({ enabled: true, services: ["dtr"] }, OTHER_BPNL),
    ).toThrow(
      `deployment.yaml: basyx.${OTHER_BPNL}: no connector in this deployment has participantId ${OTHER_BPNL}`,
    );
  });

  test("dtrConnector does not exist", () => {
    expect(() =>
      load({ enabled: true, services: ["dtr"], dtrConnector: "nope" }),
    ).toThrow(
      `deployment.yaml: basyx.${BPNL}.dtrConnector 'nope' does not exist`,
    );
  });

  test("dtrConnector belongs to another BPNL", () => {
    expect(() =>
      load({ enabled: true, services: ["dtr"], dtrConnector: "bb" }, BPNL, {
        a: baseConnector("aa"),
        b: otherBpnlConnector("bb"),
      }),
    ).toThrow(
      `deployment.yaml: basyx.${BPNL}.dtrConnector 'bb' belongs to ${OTHER_BPNL}`,
    );
  });

  test("enabled: false skips the connector checks", () => {
    expect(() =>
      load(
        { enabled: false, services: ["dtr"], dtrConnector: "nope" },
        OTHER_BPNL,
      ),
    ).not.toThrow();
  });
});

describe("resolveStateRemovalPolicy", () => {
  const d = baseDeployment() as unknown as DeploymentYaml;
  test("defaults to RETAIN", () => {
    expect(resolveStateRemovalPolicy(d)).toBe("RETAIN");
  });
  test("uses the deployment value", () => {
    expect(
      resolveStateRemovalPolicy({ ...d, stateRemovalPolicy: "DESTROY" }),
    ).toBe("DESTROY");
  });
  test("connector or BaSyx override wins", () => {
    expect(
      resolveStateRemovalPolicy(
        { ...d, stateRemovalPolicy: "DESTROY" },
        "RETAIN",
      ),
    ).toBe("RETAIN");
    expect(resolveStateRemovalPolicy(d, "DESTROY")).toBe("DESTROY");
  });
});

describe("enabledBasyx", () => {
  const config = (basyx: Record<string, unknown>): DeploymentConfig =>
    loadDeploymentConfig(
      writeConfig(
        { ...baseDeployment(), basyx },
        {
          z: baseConnector("zz"),
          b: baseConnector("bb"),
          o: otherBpnlConnector("oo"),
        },
      ),
    );

  test("defaults dtrConnector to the BPNL's first connector by file name", () => {
    expect(
      enabledBasyx(config({ [BPNL]: { enabled: true, services: ["dtr"] } })),
    ).toEqual([
      {
        bpnl: BPNL,
        entry: { enabled: true, services: ["dtr"] },
        dtrConnectorId: "bb",
      },
    ]);
  });

  test("uses an explicit dtrConnector, skips disabled, sorts by BPNL", () => {
    const result = enabledBasyx(
      config({
        [BPNL]: { enabled: true, services: ["dtr"], dtrConnector: "zz" },
        [OTHER_BPNL]: { enabled: true, services: ["dtr"] },
        BPNL00000000CCCC: { enabled: false, services: ["dtr"] },
      }),
    );
    expect(result.map((r) => [r.bpnl, r.dtrConnectorId])).toEqual([
      [OTHER_BPNL, "oo"],
      [BPNL, "zz"],
    ]);
  });
});

describe("basyxStackName", () => {
  test("uses the BaSyx brand spelling", () => {
    expect(basyxStackName("DataspaceConnector", BPNL)).toBe(
      `DataspaceConnector-BaSyx-${BPNL}`,
    );
  });
});
