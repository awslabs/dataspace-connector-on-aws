// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertDeploymentName,
  DEFAULT_DEPLOYMENT_NAME,
  DeploymentYaml,
  ConnectorYaml,
  connectorPriority,
  deriveAdminSecretName,
  deriveConnectorClusterIdentifier,
  deriveConnectorTableName,
  deriveSecretPrefix,
  connectorBpnl,
  edcIdentityEnvironment,
  resolveDeploymentName,
  toPrincipals,
  toRemovalPolicy,
  validateClusterIdentifier,
  validateConnectorId,
  validateDeploymentName,
  validateLogLevel,
} from "../lib/config/config";
import { STS_DIM_URL } from "../lib/portal-connector/client";
import {
  basyxStackName,
  DeploymentConfig,
  basyxEntries,
  loadDeploymentConfig,
  loadPipelineConfig,
  persistenceTypesInUse,
} from "../lib/config/config";
import { RemovalPolicy } from "aws-cdk-lib";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import * as yaml from "js-yaml";

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

describe("assertDeploymentName", () => {
  test("passes without a pipeline name or with the same name", () => {
    expect(() => assertDeploymentName("Acme")).not.toThrow();
    expect(() => assertDeploymentName("Acme", "Acme")).not.toThrow();
  });

  test("fails when the config repo renames the deployment", () => {
    expect(() => assertDeploymentName("Acme", "DataspaceConnector")).toThrow(
      'pipeline.yaml sets deploymentName "Acme", but this pipeline was created as "DataspaceConnector". deploymentName cannot change after the first deploy.',
    );
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

describe("connectorBpnl", () => {
  const deployment = {
    portal: { environment: "beta", bpnl: "BPNL00000000DFLT" },
  } as unknown as DeploymentYaml;

  test("the connector's own BPNL wins", () => {
    const connector = { bpnl: "BPNL00000000OWN1" } as unknown as ConnectorYaml;
    expect(connectorBpnl(deployment, connector)).toBe("BPNL00000000OWN1");
  });

  test("falls back to the deployment default", () => {
    expect(connectorBpnl(deployment, {} as ConnectorYaml)).toBe(
      "BPNL00000000DFLT",
    );
  });
});

describe("edcIdentityEnvironment", () => {
  const env = edcIdentityEnvironment("beta", "BPNL00000000AAAA", {
    clientId: "client-1",
    stsOauthTokenUrl: "https://auth.example/oauth/token",
  });

  test("derives the company DID from the BPNL", () => {
    const did =
      "did:web:portal-backend.beta.cofinity-x.com:api:administration:staticdata:did:BPNL00000000AAAA";
    expect(env["edc.participant.id"]).toBe(did);
    expect(env["edc.iam.issuer.id"]).toBe(did);
    expect(env["tractusx.edc.participant.bpn"]).toBe("BPNL00000000AAAA");
  });

  test("takes the environment constants and the technical user's values", () => {
    expect(env["edc.iam.trusted-issuer.issuer-1.id"]).toMatch(
      /:did:BPNLCOFINITYEZFA$/,
    );
    expect(env["tx.edc.iam.iatp.bdrs.server.url"]).toBe(
      "https://bdrs.beta.cofinity-x.com/api/directory",
    );
    expect(env["tx.edc.iam.sts.dim.url"]).toBe(STS_DIM_URL);
    expect(env["edc.iam.sts.oauth.client.id"]).toBe("client-1");
    expect(env["edc.iam.sts.oauth.token.url"]).toBe(
      "https://auth.example/oauth/token",
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

const BPNL = "BPNL00000000DEMO";
const OTHER_BPNL = "BPNL00000000BBBB";

const baseDeployment = (): Record<string, unknown> => ({
  profile: "development",
  vpcIpAddresses: "10.0.0.0/20",
  containerInsights: true,
  managementApiPrincipals: [],
  observabilityApiPrincipals: [],
  portal: { environment: "beta", bpnl: BPNL },
});

const baseConnector = (id: string): Record<string, unknown> => ({
  connectorId: id,
  controlPlaneCpu: 256,
  controlPlaneMemoryLimitMiB: 1024,
  dataPlaneCpu: 256,
  dataPlaneMemoryLimitMiB: 512,
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
  bpnl: OTHER_BPNL,
});

const oneConnector = () => ({ a: baseConnector("aa") });

describe("loader", () => {
  test("accepts a deployment without connectors", () => {
    expect(
      loadDeploymentConfig(writeConfig(baseDeployment(), {})).connectors,
    ).toEqual([]);
  });

  test("github configSource needs configRepoName and connectionArn", () => {
    const dir = writeConfig(baseDeployment(), oneConnector(), {
      appRepo: "x/y",
      appVersion: "main",
      configSource: "github",
    });
    expect(() => loadPipelineConfig(dir)).toThrow(
      "pipeline.yaml: configSource github requires configRepoName and connectionArn",
    );
  });

  test("rejects an unknown configSource", () => {
    const dir = writeConfig(baseDeployment(), oneConnector(), {
      appRepo: "x/y",
      appVersion: "main",
      configSource: "GitHub",
    });
    expect(() => loadPipelineConfig(dir)).toThrow(
      'pipeline.yaml: configSource must be codecommit or github, got "GitHub"',
    );
  });
});

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

  test("deployment.yaml key inside a basyx entry", () => {
    const dir = writeConfig(withBasyx({ service: ["dtr"] }), oneConnector());
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
});

describe("portal config", () => {
  const portal = (p: Record<string, unknown>) => ({
    ...baseDeployment(),
    portal: p,
  });

  test("a connector without any BPNL is rejected", () => {
    const dir = writeConfig(portal({ environment: "beta" }), oneConnector());
    expect(() => loadDeploymentConfig(dir)).toThrow(
      "connectors/connector-a.yaml: no BPNL",
    );
  });

  test("per-connector BPNLs need no default", () => {
    const dir = writeConfig(portal({ environment: "beta" }), {
      a: { ...baseConnector("aa"), bpnl: BPNL },
    });
    expect(() => loadDeploymentConfig(dir)).not.toThrow();
  });

  test("an invalid BPNL is rejected", () => {
    const dir = writeConfig(
      portal({ environment: "beta", bpnl: "BPNL-1" }),
      oneConnector(),
    );
    expect(() => loadDeploymentConfig(dir)).toThrow("portal.bpnl 'BPNL-1'");
  });

  test("production is accepted", () => {
    const dir = writeConfig(
      portal({ environment: "production", bpnl: BPNL }),
      oneConnector(),
    );
    expect(loadDeploymentConfig(dir).deployment.portal.environment).toBe(
      "production",
    );
  });

  test("an unknown environment is rejected", () => {
    const dir = writeConfig(
      portal({ environment: "staging", bpnl: BPNL }),
      oneConnector(),
    );
    expect(() => loadDeploymentConfig(dir)).toThrow(/beta" or "production/);
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
      withBasyx({ services: ["dtr"], stateRemovalPolicy: "X" }),
      oneConnector(),
    );
    expect(() => loadDeploymentConfig(dir)).toThrow(
      `deployment.yaml: basyx.${BPNL}.stateRemovalPolicy must be "RETAIN" or "DESTROY", got "X"`,
    );
  });
});

describe("persistence", () => {
  test("deployment defaults to dynamodb", () => {
    const { deployment, connectors } = loadDeploymentConfig(
      writeConfig(baseDeployment(), oneConnector()),
    );
    expect(deployment.persistence).toBe("dynamodb");
    expect(connectors[0].persistence).toBe("dynamodb");
  });

  test("connector inherits the deployment value", () => {
    const { connectors } = loadDeploymentConfig(
      writeConfig(
        { ...baseDeployment(), persistence: "postgres" },
        { a: baseConnector("aa"), b: baseConnector("bb") },
      ),
    );
    expect(connectors.map((c) => c.persistence)).toEqual([
      "postgres",
      "postgres",
    ]);
  });

  test("connector override wins over the deployment value", () => {
    const { deployment, connectors } = loadDeploymentConfig(
      writeConfig(baseDeployment(), {
        a: { ...baseConnector("aa"), persistence: "postgres" },
        b: baseConnector("bb"),
      }),
    );
    expect(deployment.persistence).toBe("dynamodb");
    expect(connectors.map((c) => c.persistence)).toEqual([
      "postgres",
      "dynamodb",
    ]);
  });

  test("connector can override a postgres deployment back to dynamodb", () => {
    const { connectors } = loadDeploymentConfig(
      writeConfig(
        { ...baseDeployment(), persistence: "postgres" },
        { a: { ...baseConnector("aa"), persistence: "dynamodb" } },
      ),
    );
    expect(connectors[0].persistence).toBe("dynamodb");
  });

  test("deployment value must be dynamodb or postgres", () => {
    const dir = writeConfig(
      { ...baseDeployment(), persistence: "mysql" },
      oneConnector(),
    );
    expect(() => loadDeploymentConfig(dir)).toThrow(
      'deployment.yaml: persistence must be "dynamodb" or "postgres", got "mysql"',
    );
  });

  test("the old value aurora is rejected, not accepted as an alias", () => {
    const dir = writeConfig(
      { ...baseDeployment(), persistence: "aurora" },
      oneConnector(),
    );
    expect(() => loadDeploymentConfig(dir)).toThrow(
      'deployment.yaml: persistence must be "dynamodb" or "postgres", got "aurora"',
    );
    const connector = writeConfig(baseDeployment(), {
      a: { ...baseConnector("aa"), persistence: "aurora" },
    });
    expect(() => loadDeploymentConfig(connector)).toThrow(
      'connectors/connector-a.yaml: persistence must be "dynamodb" or "postgres", got "aurora"',
    );
  });

  test("connector value must be dynamodb or postgres", () => {
    const dir = writeConfig(baseDeployment(), {
      a: { ...baseConnector("aa"), persistence: "Postgres" },
    });
    expect(() => loadDeploymentConfig(dir)).toThrow(
      'connectors/connector-a.yaml: persistence must be "dynamodb" or "postgres", got "Postgres"',
    );
  });

  test("an empty value is rejected rather than defaulted", () => {
    const dir = writeConfig(baseDeployment(), {
      a: { ...baseConnector("aa"), persistence: null },
    });
    expect(() => loadDeploymentConfig(dir)).toThrow(
      'connectors/connector-a.yaml: persistence must be "dynamodb" or "postgres", got "null"',
    );
  });

  describe("persistenceTypesInUse", () => {
    const typesIn = (
      deploymentPersistence: string | undefined,
      overrides: Array<string | undefined>,
    ) => {
      const connectors = Object.fromEntries(
        overrides.map((persistence, i) => [
          `c${i}`,
          {
            ...baseConnector(`conn-${i}`),
            ...(persistence ? { persistence } : {}),
          },
        ]),
      );
      return [
        ...persistenceTypesInUse(
          loadDeploymentConfig(
            writeConfig(
              {
                ...baseDeployment(),
                ...(deploymentPersistence
                  ? { persistence: deploymentPersistence }
                  : {}),
              },
              connectors,
            ),
          ),
        ),
      ];
    };

    test("is dynamodb alone by default", () => {
      expect(typesIn(undefined, [undefined, undefined])).toEqual(["dynamodb"]);
    });

    test("follows the deployment default", () => {
      expect(typesIn("postgres", [undefined, undefined])).toEqual(["postgres"]);
    });

    test("is postgres alone when every connector overrides to postgres", () => {
      expect(typesIn(undefined, ["postgres", "postgres"])).toEqual([
        "postgres",
      ]);
    });

    test("lists both types in PERSISTENCE_TYPES order, once each", () => {
      expect(typesIn(undefined, ["postgres", undefined, "postgres"])).toEqual([
        "dynamodb",
        "postgres",
      ]);
      expect(typesIn("postgres", ["dynamodb", undefined])).toEqual([
        "dynamodb",
        "postgres",
      ]);
    });
  });

  test("a misspelled key is still rejected", () => {
    const deployment = writeConfig(
      { ...baseDeployment(), persistance: "postgres" },
      oneConnector(),
    );
    expect(() => loadDeploymentConfig(deployment)).toThrow(
      "deployment.yaml: unknown key 'persistance'",
    );
    const connector = writeConfig(baseDeployment(), {
      a: { ...baseConnector("aa"), persistance: "postgres" },
    });
    expect(() => loadDeploymentConfig(connector)).toThrow(
      "connectors/connector-a.yaml: unknown key 'persistance'",
    );
  });
});

describe("Aurora cluster identifier", () => {
  test("is the lowercased deployment and connector name", () => {
    expect(deriveConnectorClusterIdentifier("DataspaceConnector", "ccm")).toBe(
      "dataspaceconnector-ccm",
    );
  });

  test("accepts the default deployment name with a long connectorId", () => {
    expect(() =>
      validateClusterIdentifier("DataspaceConnector", "c".repeat(44)),
    ).not.toThrow();
  });

  test("accepts exactly 63 characters", () => {
    expect(() =>
      validateClusterIdentifier("d".repeat(10), "c".repeat(52)),
    ).not.toThrow();
  });

  test("rejects more than 63 characters", () => {
    expect(() =>
      validateClusterIdentifier("d".repeat(10), "c".repeat(53)),
    ).toThrow(/is 64 characters \(max 63\)/);
  });

  test("rejects the maximum deploymentName with the maximum connectorId", () => {
    expect(() =>
      validateClusterIdentifier("d".repeat(41), "c".repeat(60)),
    ).toThrow(/characters \(max 63\)/);
  });

  test("rejects an identifier that starts with a digit", () => {
    expect(() => validateClusterIdentifier("1dep", "ccm")).toThrow(
      /must start with a letter/,
    );
  });

  test("rejects consecutive hyphens from either part", () => {
    expect(() => validateClusterIdentifier("dep--x", "ccm")).toThrow(
      /two consecutive hyphens/,
    );
    expect(() => validateClusterIdentifier("dep", "a--b")).toThrow(
      /two consecutive hyphens/,
    );
  });
});

describe("profile validation", () => {
  test("connector value", () => {
    const dir = writeConfig(baseDeployment(), {
      a: { ...baseConnector("aa"), profile: "prod" },
    });
    expect(() => loadDeploymentConfig(dir)).toThrow(
      'connectors/connector-a.yaml: profile must be "development" or "production", got "prod"',
    );
  });

  test("basyx entry value", () => {
    const dir = writeConfig(
      withBasyx({ services: ["dtr"], profile: "prod" }),
      oneConnector(),
    );
    expect(() => loadDeploymentConfig(dir)).toThrow(
      `deployment.yaml: basyx.${BPNL}.profile must be "development" or "production", got "prod"`,
    );
  });

  test("basyx entry accepts a valid profile", () => {
    const dir = writeConfig(
      withBasyx({ services: ["dtr"], profile: "production" }),
      oneConnector(),
    );
    expect(() => loadDeploymentConfig(dir)).not.toThrow();
  });
});

describe("basyx validation", () => {
  const load = (
    entry: Record<string, unknown>,
    key = BPNL,
    connectors: Record<string, Record<string, unknown>> = oneConnector(),
  ) => loadDeploymentConfig(writeConfig(withBasyx(entry, key), connectors));

  test("invalid BPNL key", () => {
    expect(() => load({ services: ["dtr"] }, "BPNL123")).toThrow(
      "deployment.yaml: basyx key 'BPNL123' is not a valid BPNL",
    );
  });

  test("the removed enabled flag", () => {
    expect(() => load({ enabled: true, services: ["dtr"] })).toThrow(
      `deployment.yaml: unknown key 'basyx.${BPNL}.enabled'`,
    );
  });

  test("services empty", () => {
    expect(() => load({ services: [] })).toThrow(
      `deployment.yaml: basyx.${BPNL}.services must be a non-empty list`,
    );
  });

  test("unknown service", () => {
    expect(() => load({ services: ["dtr", "dpp"] })).toThrow(
      `deployment.yaml: basyx.${BPNL}.services: unknown service 'dpp' (allowed: dtr, submodelRepository)`,
    );
  });

  test("services without dtr", () => {
    expect(() => load({ services: ["submodelRepository"] })).toThrow(
      `deployment.yaml: basyx.${BPNL}.services must include 'dtr'`,
    );
  });

  test("BPNL without connector", () => {
    expect(() => load({ services: ["dtr"] }, OTHER_BPNL)).toThrow(
      `deployment.yaml: basyx.${OTHER_BPNL}: no connector in this deployment has BPNL ${OTHER_BPNL}`,
    );
  });

  test("dtrConnector does not exist", () => {
    expect(() => load({ services: ["dtr"], dtrConnector: "nope" })).toThrow(
      `deployment.yaml: basyx.${BPNL}.dtrConnector 'nope' does not exist`,
    );
  });

  test("dtrConnector belongs to another BPNL", () => {
    expect(() =>
      load({ services: ["dtr"], dtrConnector: "bb" }, BPNL, {
        a: baseConnector("aa"),
        b: otherBpnlConnector("bb"),
      }),
    ).toThrow(
      `deployment.yaml: basyx.${BPNL}.dtrConnector 'bb' belongs to ${OTHER_BPNL}`,
    );
  });
});

describe("basyxEntries", () => {
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
    expect(basyxEntries(config({ [BPNL]: { services: ["dtr"] } }))).toEqual([
      {
        bpnl: BPNL,
        services: ["dtr"],
        dtrConnector: "bb",
        profile: "development",
        stateRemovalPolicy: "RETAIN",
      },
    ]);
  });

  test("uses an explicit dtrConnector, sorts by BPNL", () => {
    const result = basyxEntries(
      config({
        [BPNL]: { services: ["dtr"], dtrConnector: "zz" },
        [OTHER_BPNL]: { services: ["dtr"] },
      }),
    );
    expect(result.map((r) => [r.bpnl, r.dtrConnector])).toEqual([
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
