// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerReadyConnectors } from "../lib/portal/finalize";
import { ConnectorState } from "../lib/portal/state";
import { ConnectorRegistration, PortalClient } from "../lib/portal/client";
import { ConnectorYaml } from "../lib/config/config";

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
    edcStateRemovalPolicy: "DESTROY",
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
