// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConnectorState, StateStore, nextState } from "../lib/portal/state";

const base: ConnectorState = {
  connectorId: "alpha",
  orgKey: "BPNL1",
  phase: "IDENTITY_PENDING",
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
};

describe("nextState", () => {
  test("advances the phase forward and marks changed", () => {
    const { state, changed } = nextState(base, { phase: "IDENTITY_READY" });
    expect(changed).toBe(true);
    expect(state.phase).toBe("IDENTITY_READY");
    expect(state.updatedAt).not.toBe(base.updatedAt);
  });

  test("never regresses the phase", () => {
    const registered: ConnectorState = { ...base, phase: "REGISTERED" };
    const { state, changed } = nextState(registered, {
      phase: "IDENTITY_PENDING",
    });
    expect(state.phase).toBe("REGISTERED");
    expect(changed).toBe(false);
  });

  test("records portalConnectorId and keeps createdAt", () => {
    const { state, changed } = nextState(base, {
      phase: "REGISTERED",
      portalConnectorId: "portal-99",
    });
    expect(changed).toBe(true);
    expect(state.portalConnectorId).toBe("portal-99");
    expect(state.createdAt).toBe(base.createdAt);
  });

  test("is a no-op when nothing meaningful changes (updatedAt frozen)", () => {
    const { state, changed } = nextState(base, {
      phase: "IDENTITY_PENDING",
      orgKey: "BPNL1",
    });
    expect(changed).toBe(false);
    expect(state.updatedAt).toBe(base.updatedAt);
  });

  test("undefined updates preserve current values", () => {
    const withId: ConnectorState = { ...base, portalConnectorId: "keep-me" };
    const { state } = nextState(withId, { phase: "IDENTITY_READY" });
    expect(state.portalConnectorId).toBe("keep-me");
    expect(state.orgKey).toBe("BPNL1");
  });
});

describe("StateStore", () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => ddb.reset());

  test("get returns undefined when the item is absent", async () => {
    ddb.on(GetCommand).resolves({});
    const store = new StateStore("tbl");
    expect(await store.get("alpha")).toBeUndefined();
  });

  test("get maps a stored item to ConnectorState", async () => {
    ddb.on(GetCommand).resolves({
      Item: {
        pk: "CONNECTOR",
        sk: "alpha",
        orgKey: "BPNL1",
        phase: "REGISTERED",
        portalConnectorId: "p1",
        createdAt: "t0",
        updatedAt: "t1",
      },
    });
    const store = new StateStore("tbl");
    const s = await store.get("alpha");
    expect(s).toMatchObject({
      connectorId: "alpha",
      orgKey: "BPNL1",
      phase: "REGISTERED",
      portalConnectorId: "p1",
    });
  });

  test("list queries by the CONNECTOR partition key", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        {
          sk: "alpha",
          orgKey: "BPNL1",
          phase: "IDENTITY_READY",
          createdAt: "t",
          updatedAt: "t",
        },
        {
          sk: "bravo",
          orgKey: "BPNL2",
          phase: "REGISTERED",
          createdAt: "t",
          updatedAt: "t",
        },
      ],
    });
    const store = new StateStore("tbl");
    const rows = await store.list();
    expect(rows.map((r) => r.connectorId)).toEqual(["alpha", "bravo"]);
    const input = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues).toEqual({ ":pk": "CONNECTOR" });
  });

  test("ensureRow creates a PENDING row when absent", async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    const store = new StateStore("tbl");
    const state = await store.ensureRow("alpha", "BPNL1");
    expect(state.phase).toBe("IDENTITY_PENDING");
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(item).toMatchObject({
      pk: "CONNECTOR",
      sk: "alpha",
      orgKey: "BPNL1",
      phase: "IDENTITY_PENDING",
    });
  });

  test("ensureRow does not write when the row already exists", async () => {
    ddb.on(GetCommand).resolves({
      Item: {
        sk: "alpha",
        orgKey: "BPNL1",
        phase: "REGISTERED",
        createdAt: "t",
        updatedAt: "t",
      },
    });
    const store = new StateStore("tbl");
    await store.ensureRow("alpha", "BPNL1");
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("save omits portalConnectorId when unset", async () => {
    ddb.on(PutCommand).resolves({});
    const store = new StateStore("tbl");
    await store.save(base);
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item as Record<
      string,
      unknown
    >;
    expect(item).not.toHaveProperty("portalConnectorId");
    expect(item).toMatchObject({ pk: "CONNECTOR", sk: "alpha" });
  });

  test("remove deletes by the composite key", async () => {
    ddb.on(DeleteCommand).resolves({});
    const store = new StateStore("tbl");
    await store.remove("alpha");
    expect(ddb.commandCalls(DeleteCommand)[0].args[0].input.Key).toEqual({
      pk: "CONNECTOR",
      sk: "alpha",
    });
  });
});
