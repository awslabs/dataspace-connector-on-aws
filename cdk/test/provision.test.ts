// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { reconcile } from "../lib/portal/provision";
import { ConnectorState, StateStore } from "../lib/portal/state";
import { PortalClient } from "../lib/portal/client";
import {
  ConnectorYaml,
  DeploymentYaml,
  PortalIdentity,
} from "../lib/config/config";

const identity: PortalIdentity = {
  trustedIssuer: "did:web:issuer",
  stsOauthTokenUrl: "https://token",
  stsDimUrl: "https://dim",
  participantId: "BPNL-A",
  dcpId: "did:web:dcp",
  didResolver: "https://bdrs",
};

function deploymentWith(id: Partial<PortalIdentity>): DeploymentYaml {
  return {
    portal: { environment: "beta", identity: id },
  } as unknown as DeploymentYaml;
}

function connector(overrides: Partial<ConnectorYaml> = {}): ConnectorYaml {
  return {
    connectorId: "alpha",
    controlPlaneCpu: 256,
    controlPlaneMemoryLimitMiB: 1024,
    dataPlaneCpu: 256,
    dataPlaneMemoryLimitMiB: 512,
    edcStateRemovalPolicy: "DESTROY",
    serviceAccountId: "sa-1",
    ...overrides,
  } as ConnectorYaml;
}

/** In-memory StateStore replacement recording saves. */
class FakeStore {
  rows = new Map<string, ConnectorState>();
  saves: ConnectorState[] = [];
  constructor(seed: ConnectorState[] = []) {
    for (const s of seed) this.rows.set(s.connectorId, s);
  }
  async list(): Promise<ConnectorState[]> {
    return [...this.rows.values()];
  }
  async get(id: string): Promise<ConnectorState | undefined> {
    return this.rows.get(id);
  }
  async ensureRow(id: string, orgKey: string): Promise<ConnectorState> {
    const existing = this.rows.get(id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const state: ConnectorState = {
      connectorId: id,
      orgKey,
      phase: "IDENTITY_PENDING",
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, state);
    return state;
  }
  async save(s: ConnectorState): Promise<void> {
    this.saves.push(s);
    this.rows.set(s.connectorId, s);
  }
  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

const asStore = (f: FakeStore) => f as unknown as StateStore;

function activeClient(clientId = "client-1"): PortalClient {
  return {
    getTechUserDetails: async () => ({
      status: "ACTIVE",
      clientId,
      secret: "secret-1",
    }),
  } as unknown as PortalClient;
}

const clientFor =
  (map: Record<string, PortalClient | null>) =>
  async (bpnl: string): Promise<PortalClient | null> =>
    map[bpnl] ?? null;

describe("reconcile", () => {
  test("resolves a connector whose prerequisites are met to IDENTITY_READY", async () => {
    const store = new FakeStore();
    const { resolved } = await reconcile(
      deploymentWith(identity),
      [connector()],
      asStore(store),
      clientFor({ "BPNL-A": activeClient("client-xyz") }),
    );
    expect(resolved.alpha).toBeDefined();
    expect(resolved.alpha.stsOauthClientId).toBe("client-xyz");
    expect(resolved.alpha.participantId).toBe("BPNL-A");
    expect(store.rows.get("alpha")?.phase).toBe("IDENTITY_READY");
  });

  test("leaves a connector PENDING when the effective identity is incomplete", async () => {
    const store = new FakeStore();
    const { resolved } = await reconcile(
      deploymentWith({ ...identity, didResolver: undefined }),
      [connector()],
      asStore(store),
      clientFor({ "BPNL-A": activeClient() }),
    );
    expect(resolved.alpha).toBeUndefined();
    expect(store.rows.get("alpha")?.phase).toBe("IDENTITY_PENDING");
  });

  test("leaves a connector PENDING when the admin secret is unavailable", async () => {
    const store = new FakeStore();
    const { resolved } = await reconcile(
      deploymentWith(identity),
      [connector()],
      asStore(store),
      clientFor({}), // getClient returns null for BPNL-A
    );
    expect(resolved.alpha).toBeUndefined();
    expect(store.rows.get("alpha")?.phase).toBe("IDENTITY_PENDING");
  });

  test("leaves a connector PENDING when the technical user is not ACTIVE", async () => {
    const store = new FakeStore();
    const pendingUser = {
      getTechUserDetails: async () => ({
        status: "PENDING",
        clientId: "c",
        secret: "s",
      }),
    } as unknown as PortalClient;
    const { resolved } = await reconcile(
      deploymentWith(identity),
      [connector()],
      asStore(store),
      clientFor({ "BPNL-A": pendingUser }),
    );
    expect(resolved.alpha).toBeUndefined();
    expect(store.rows.get("alpha")?.phase).toBe("IDENTITY_PENDING");
  });

  test("leaves a connector PENDING when the technical user lookup throws", async () => {
    const store = new FakeStore();
    const throwingUser = {
      getTechUserDetails: async () => {
        throw new Error("portal 404");
      },
    } as unknown as PortalClient;
    const { resolved } = await reconcile(
      deploymentWith(identity),
      [connector()],
      asStore(store),
      clientFor({ "BPNL-A": throwingUser }),
    );
    expect(resolved.alpha).toBeUndefined();
    expect(store.rows.get("alpha")?.phase).toBe("IDENTITY_PENDING");
  });

  test("one failing connector does not block a healthy one", async () => {
    const store = new FakeStore();
    const { resolved } = await reconcile(
      deploymentWith(identity),
      [
        connector({ connectorId: "healthy", serviceAccountId: "sa-ok" }),
        connector({
          connectorId: "broken",
          serviceAccountId: "sa-bad",
          portal: { identity: { participantId: "BPNL-NOSECRET" } },
        }),
      ],
      asStore(store),
      clientFor({ "BPNL-A": activeClient() }), // BPNL-NOSECRET has no client
    );
    expect(resolved.healthy).toBeDefined();
    expect(resolved.broken).toBeUndefined();
    expect(store.rows.get("broken")?.phase).toBe("IDENTITY_PENDING");
  });

  test("activeBpnls unions config BPNLs with existing DDB orgKeys", async () => {
    // An offboarded connector's row (not in config) keeps its tenant active.
    const store = new FakeStore([
      {
        connectorId: "offboarded",
        orgKey: "BPNL-OLD",
        phase: "REGISTERED",
        createdAt: "t",
        updatedAt: "t",
      },
    ]);
    const { activeBpnls } = await reconcile(
      deploymentWith(identity),
      [connector()],
      asStore(store),
      clientFor({ "BPNL-A": activeClient() }),
    );
    expect(activeBpnls.sort()).toEqual(["BPNL-A", "BPNL-OLD"]);
  });
});
