// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { reconcileBasyx } from "../lib/portal/finalize";
import { ManagementRequest } from "../lib/portal/management-api";
import { ConnectorYaml, DeploymentConfig } from "../lib/config/config";

function conn(id: string): ConnectorYaml {
  return {
    connectorId: id,
    controlPlaneCpu: 256,
    controlPlaneMemoryLimitMiB: 1024,
    dataPlaneCpu: 256,
    dataPlaneMemoryLimitMiB: 512,
    stateRemovalPolicy: "DESTROY",
  } as ConnectorYaml;
}

describe("reconcileBasyx", () => {
  const outputs = {
    dtrUrl: "http://dtr/api/v3",
    tokenUrl: "https://t/oauth2/token",
    clientId: "c",
    scope: "s",
    clientSecretAlias: "a",
  };

  function setup(opts: { basyx?: Record<string, unknown>; live?: string[] }) {
    const config = {
      deployment: {
        portal: { environment: "beta", bpnl: "BPNL1" },
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
      reconcileBasyx(config, {
        liveBasyxStacks: async () => new Set(opts.live ?? []),
        readOutputs: async () => outputs,
        api,
        deleteBasyxStack,
      });
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

  test("a failure is reported per BPNL", async () => {
    const { run, deleteBasyxStack } = setup({ live: ["BPNL1"] });
    deleteBasyxStack.mockRejectedValueOnce(new Error("DELETE_FAILED"));
    expect(await run()).toEqual(["BPNL1"]);
  });
});
