// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  reconcileBasyx,
  registerReadyConnectors,
} from "../lib/portal/finalize";
import { ManagementRequest } from "../lib/portal/management-api";
import { ConnectorState } from "../lib/portal/state";
import { ConnectorRegistration, PortalClient } from "../lib/portal/client";
import { ConnectorYaml, DeploymentConfig } from "../lib/config/config";

function row(overrides: Partial<ConnectorState> = {}): ConnectorState {
  return {
    connectorId: "alpha",
    orgKey: "BPNL1",
    phase: "IDENTITY_READY",
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

function conn(id: string): ConnectorYaml {
  return {
    connectorId: id,
    controlPlaneCpu: 256,
    controlPlaneMemoryLimitMiB: 1024,
    dataPlaneCpu: 256,
    dataPlaneMemoryLimitMiB: 512,
    stateRemovalPolicy: "DESTROY",
    serviceAccountId: `sa-${id}`,
  } as ConnectorYaml;
}

/** Portal client stub; registerConnector throws for ids listed in failIds. */
function client(failIds: string[] = []): PortalClient {
  return {
    getTechUserDetails: async () => ({
      status: "ACTIVE",
      clientId: "c",
      secret: "the-secret",
    }),
    registerConnector: async (connectorId: string) => {
      if (failIds.includes(connectorId)) {
        throw new Error(`400 CONNECTOR_ARGUMENT_TECH_USER_IN_USE`);
      }
      return { id: `portal-${connectorId}` } as ConnectorRegistration;
    },
  } as unknown as PortalClient;
}

function deps(
  c: PortalClient,
  registry: Map<string, ConnectorRegistration> = new Map(),
) {
  const saved: ConnectorState[] = [];
  const putSecret = jest.fn(async () => {});
  return {
    saved,
    putSecret,
    deps: {
      getClient: async () => c,
      registryByTenant: new Map([["BPNL1", registry]]),
      store: { save: async (s: ConnectorState) => void saved.push(s) },
      secrets: { putConnectorSecret: putSecret },
    },
  };
}

describe("registerReadyConnectors", () => {
  test("registers a READY connector and records the portal id", async () => {
    const { saved, putSecret, deps: d } = deps(client());
    const failures = await registerReadyConnectors(
      [row()],
      [conn("alpha")],
      "dep",
      "https://dsp/",
      d,
    );
    expect(failures).toEqual([]);
    expect(putSecret).toHaveBeenCalledWith(
      "dep/alpha/edc.iam.sts.oauth.client.secret",
      "the-secret",
    );
    expect(saved[0]).toMatchObject({
      connectorId: "alpha",
      phase: "REGISTERED",
      portalConnectorId: "portal-alpha",
    });
  });

  test("self-heals a connector already registered at the portal without re-registering", async () => {
    const registry = new Map<string, ConnectorRegistration>([
      ["alpha", { id: "existing-99" } as ConnectorRegistration],
    ]);
    const spy = client();
    const registerSpy = jest.spyOn(spy, "registerConnector");
    const { saved, deps: d } = deps(spy, registry);
    const failures = await registerReadyConnectors(
      [row()],
      [conn("alpha")],
      "dep",
      "https://dsp/",
      d,
    );
    expect(failures).toEqual([]);
    expect(registerSpy).not.toHaveBeenCalled();
    expect(saved[0]).toMatchObject({
      phase: "REGISTERED",
      portalConnectorId: "existing-99",
    });
  });

  test("does nothing for an already-REGISTERED connector present at the portal", async () => {
    const registry = new Map<string, ConnectorRegistration>([
      ["alpha", { id: "existing-99" } as ConnectorRegistration],
    ]);
    const { saved, deps: d } = deps(client(), registry);
    const failures = await registerReadyConnectors(
      [row({ phase: "REGISTERED", portalConnectorId: "existing-99" })],
      [conn("alpha")],
      "dep",
      "https://dsp/",
      d,
    );
    expect(failures).toEqual([]);
    expect(saved).toHaveLength(0);
  });

  test("isolates a per-connector failure: the healthy connector still registers and the failure is reported", async () => {
    const { saved, deps: d } = deps(client(["broken"]));
    const failures = await registerReadyConnectors(
      [row({ connectorId: "broken" }), row({ connectorId: "healthy" })],
      [conn("broken"), conn("healthy")],
      "dep",
      "https://dsp/",
      d,
    );
    // The bad connector is reported; the healthy one still registered.
    expect(failures).toEqual(["broken"]);
    expect(saved.map((s) => s.connectorId)).toEqual(["healthy"]);
    expect(saved[0].phase).toBe("REGISTERED");
  });

  test("skips registration when the DSP URL is unavailable (no failure, stays READY)", async () => {
    const { saved, deps: d } = deps(client());
    const failures = await registerReadyConnectors(
      [row()],
      [conn("alpha")],
      "dep",
      undefined,
      d,
    );
    expect(failures).toEqual([]);
    expect(saved).toHaveLength(0);
  });

  test("skips connectors that are still IDENTITY_PENDING", async () => {
    const { saved, deps: d } = deps(client());
    const failures = await registerReadyConnectors(
      [row({ phase: "IDENTITY_PENDING" })],
      [conn("alpha")],
      "dep",
      "https://dsp/",
      d,
    );
    expect(failures).toEqual([]);
    expect(saved).toHaveLength(0);
  });

  test("skips rows whose connector is no longer in the config (orphans)", async () => {
    const { saved, deps: d } = deps(client());
    const failures = await registerReadyConnectors(
      [row({ connectorId: "gone" })],
      [conn("alpha")], // "gone" not present
      "dep",
      "https://dsp/",
      d,
    );
    expect(failures).toEqual([]);
    expect(saved).toHaveLength(0);
  });
});

describe("reconcileBasyx", () => {
  const outputs = {
    dtrUrl: "http://dtr/api/v3",
    tokenUrl: "https://t/oauth2/token",
    clientId: "c",
    scope: "s",
    clientSecretAlias: "a",
  };

  function setup(opts: {
    basyx?: Record<string, unknown>;
    live?: string[];
    rows?: ConnectorState[];
  }) {
    const config = {
      deployment: {
        portal: { identity: { participantId: "BPNL1" } },
        basyx: opts.basyx,
      },
      connectors: [conn("alpha"), conn("beta")],
    } as unknown as DeploymentConfig;
    const order: string[] = [];
    const api =
      (id: string): ManagementRequest =>
      async (method, path) => {
        order.push(`${id} ${method} ${path}`);
        return { status: method === "GET" ? 404 : 200, body: undefined };
      };
    const deleteBasyxStack = jest.fn(async (bpnl: string) => {
      order.push(`delete ${bpnl}`);
    });
    const run = () =>
      reconcileBasyx(
        config,
        opts.rows ?? [row(), row({ connectorId: "beta" })],
        {
          liveBasyxStacks: async () => new Set(opts.live ?? []),
          readOutputs: async () => outputs,
          api,
          deleteBasyxStack,
        },
      );
    return { run, order, deleteBasyxStack };
  }

  test("no BaSyx anywhere makes no calls", async () => {
    const { run, order } = setup({});
    expect(await run()).toEqual([]);
    expect(order).toEqual([]);
  });

  test("creates the offer on the dtrConnector and probes the others", async () => {
    const { run, order } = setup({
      basyx: {
        BPNL1: { services: ["dtr"], dtrConnector: "beta" },
      },
      live: ["BPNL1"],
    });
    expect(await run()).toEqual([]);
    expect(order[0]).toBe("beta GET /assets/dataspace-connector-dtr");
    expect(order.filter((c) => c.startsWith("beta POST"))).toHaveLength(4);
    expect(order.filter((c) => c.startsWith("alpha"))).toEqual([
      "alpha GET /policydefinitions/dataspace-connector-dtr-access",
    ]);
  });

  test("removed entry: offer cleanup before the stack is deleted", async () => {
    const { run, order, deleteBasyxStack } = setup({ live: ["BPNL1"] });
    expect(await run()).toEqual([]);
    expect(deleteBasyxStack).toHaveBeenCalledWith("BPNL1");
    expect(order[order.length - 1]).toBe("delete BPNL1");
    expect(order.filter((c) => c.includes(" GET "))).toHaveLength(2);
  });

  test("dtrConnector not yet deployed: no offer, stack kept", async () => {
    const { run, order, deleteBasyxStack } = setup({
      basyx: { BPNL1: { services: ["dtr"] } },
      rows: [row({ phase: "IDENTITY_PENDING" }), row({ connectorId: "beta" })],
    });
    expect(await run()).toEqual([]);
    expect(order.some((c) => c.startsWith("alpha"))).toBe(false);
    expect(deleteBasyxStack).not.toHaveBeenCalled();
  });

  test("a failure is reported per BPNL", async () => {
    const { run, deleteBasyxStack } = setup({ live: ["BPNL1"] });
    deleteBasyxStack.mockRejectedValueOnce(new Error("DELETE_FAILED"));
    expect(await run()).toEqual(["BPNL1"]);
  });
});
