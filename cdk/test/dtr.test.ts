// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  BasyxOutputs,
  DTR_ACCESS_POLICY_ID,
  DTR_HASH_PROPERTY,
  DTR_ID,
  DTR_USAGE_POLICY_ID,
  buildDtrDefinition,
  canonicalJson,
  ensureDtr,
  removeDtr,
} from "../lib/portal/dtr";
import { ManagementRequest } from "../lib/portal/management-api";

const outputs: BasyxOutputs = {
  dtrUrl: "http://dtr.bpnl.example.basyx.internal:5004/api/v3",
  tokenUrl:
    "https://x-basyx-bpnl.auth.eu-central-1.amazoncognito.com/oauth2/token",
  clientId: "client-1",
  scope: "dataspace-connector-basyx/read",
  clientSecretAlias: "dc/alpha/basyx.dtr.oauth.client.secret",
};

type Call = [string, string];

/** Fake management API: a map of path -> status for GET/DELETE/POST. */
function fakeApi(
  responses: Record<string, { status: number; body?: unknown }>,
) {
  const calls: Call[] = [];
  const api: ManagementRequest = async (method, path, _body, allow = []) => {
    calls.push([method, path]);
    const r = responses[`${method} ${path}`] ?? { status: 200 };
    if (r.status >= 300 && !allow.includes(r.status)) {
      throw new Error(`${method} ${path} returned ${r.status}`);
    }
    return { status: r.status, body: r.body };
  };
  return { api, calls };
}

describe("buildDtrDefinition", () => {
  const def = buildDtrDefinition(outputs);

  test("asset proxies everything to the DTR with OAuth2 client credentials", () => {
    const asset = def.asset as Record<string, any>;
    expect(asset["@id"]).toBe(DTR_ID);
    expect(asset.properties["dct:type"]).toEqual({
      "@id": "cx-taxo:DigitalTwinRegistry",
    });
    expect(asset.dataAddress).toMatchObject({
      type: "HttpData",
      baseUrl: outputs.dtrUrl,
      proxyPath: "true",
      proxyQueryParams: "true",
      proxyMethod: "true",
      proxyBody: "true",
      "oauth2:tokenUrl": outputs.tokenUrl,
      "oauth2:clientId": outputs.clientId,
      "oauth2:clientSecretKey": outputs.clientSecretAlias,
      "oauth2:scope": outputs.scope,
    });
    expect(asset.privateProperties[DTR_HASH_PROPERTY]).toBe(def.hash);
  });

  test("policies and contract definition use the fixed IDs", () => {
    expect(def.accessPolicy).toMatchObject({ "@id": DTR_ACCESS_POLICY_ID });
    expect(JSON.stringify(def.accessPolicy)).toContain('"Membership"');
    // Tractus-X rejects an access policy with action "use" as an incomplete usage policy.
    expect(def.accessPolicy).toMatchObject({
      policy: { permission: [{ action: "access" }] },
    });
    expect(def.usagePolicy).toMatchObject({
      policy: { permission: [{ action: "use" }] },
    });
    expect(def.usagePolicy).toMatchObject({ "@id": DTR_USAGE_POLICY_ID });
    expect(JSON.stringify(def.usagePolicy)).toContain(
      "cx.core.digitalTwinRegistry:1",
    );
    expect(JSON.stringify(def.usagePolicy)).toContain(
      "DataExchangeGovernance:1.0",
    );
    expect(def.contractDefinition).toMatchObject({
      "@id": DTR_ID,
      accessPolicyId: DTR_ACCESS_POLICY_ID,
      contractPolicyId: DTR_USAGE_POLICY_ID,
    });
  });

  test("hash is stable and changes with any output", () => {
    expect(buildDtrDefinition({ ...outputs }).hash).toBe(def.hash);
    expect(buildDtrDefinition({ ...outputs, clientId: "other" }).hash).not.toBe(
      def.hash,
    );
  });

  test("canonicalJson ignores key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3] } })).toBe(
      canonicalJson({ a: { c: [3], d: 2 }, b: 1 }),
    );
  });
});

describe("ensureDtr", () => {
  const def = buildDtrDefinition(outputs);

  test("first run creates all four, asset last", async () => {
    const { api, calls } = fakeApi({
      [`GET /assets/${DTR_ID}`]: { status: 404 },
    });
    expect(await ensureDtr(api, def)).toBe(true);
    expect(calls).toEqual([
      ["GET", `/assets/${DTR_ID}`],
      ["DELETE", `/contractdefinitions/${DTR_ID}`],
      ["POST", "/policydefinitions"],
      ["POST", "/policydefinitions"],
      ["POST", "/contractdefinitions"],
      ["POST", "/assets"],
    ]);
  });

  test("matching hash makes no writes", async () => {
    const { api, calls } = fakeApi({
      [`GET /assets/${DTR_ID}`]: {
        status: 200,
        body: { privateProperties: { [DTR_HASH_PROPERTY]: def.hash } },
      },
    });
    expect(await ensureDtr(api, def)).toBe(false);
    expect(calls).toEqual([["GET", `/assets/${DTR_ID}`]]);
  });

  test("changed hash frees the policies, then updates them with PUT", async () => {
    // Tractus-X refuses policy writes while a contract definition references them.
    const { api, calls } = fakeApi({
      [`GET /assets/${DTR_ID}`]: {
        status: 200,
        body: { privateProperties: { [DTR_HASH_PROPERTY]: "stale" } },
      },
      "POST /policydefinitions": { status: 409 },
      "POST /assets": { status: 409 },
    });
    expect(await ensureDtr(api, def)).toBe(true);
    expect(calls.slice(1)).toEqual([
      ["DELETE", `/contractdefinitions/${DTR_ID}`],
      ["POST", "/policydefinitions"],
      ["PUT", `/policydefinitions/${DTR_ACCESS_POLICY_ID}`],
      ["POST", "/policydefinitions"],
      ["PUT", `/policydefinitions/${DTR_USAGE_POLICY_ID}`],
      ["POST", "/contractdefinitions"],
      ["POST", "/assets"],
      ["PUT", "/assets"],
    ]);
  });
});

describe("removeDtr", () => {
  test("nothing there costs one GET", async () => {
    const { api, calls } = fakeApi({
      [`GET /policydefinitions/${DTR_ACCESS_POLICY_ID}`]: { status: 404 },
    });
    expect(await removeDtr(api, jest.fn())).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("deletes in reverse order and tolerates 404 and a 409 asset", async () => {
    const warn = jest.fn();
    const { api, calls } = fakeApi({
      [`DELETE /contractdefinitions/${DTR_ID}`]: { status: 404 },
      [`DELETE /assets/${DTR_ID}`]: { status: 409 },
    });
    expect(await removeDtr(api, warn)).toBe(true);
    expect(calls.slice(1)).toEqual([
      ["DELETE", `/contractdefinitions/${DTR_ID}`],
      ["DELETE", `/assets/${DTR_ID}`],
      ["DELETE", `/policydefinitions/${DTR_USAGE_POLICY_ID}`],
      ["DELETE", `/policydefinitions/${DTR_ACCESS_POLICY_ID}`],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
