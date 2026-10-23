// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  DTR_ID,
  DtrOfferProperties,
  deps,
  onEvent,
} from "../lib/dtr-offer/handler";

const props: DtrOfferProperties = {
  ManagementUrl: "http://alb:8182",
  ConnectorId: "alpha",
  DtrUrl: "http://alb:5004/basyx/BPNL00000000DEMO/dtr/api/v3",
  TokenUrl: "https://cognito/oauth2/token",
  ClientId: "reader",
  Scope: "basyx/read",
  ClientSecretAlias: "alpha-basyx-secret",
};

let calls: string[];
let status: (method: string, path: string) => number;

beforeEach(() => {
  calls = [];
  status = () => 200;
  deps.fetch = jest.fn(async (url: string, init: RequestInit) => {
    const path = url.replace("http://alb:8182/alpha/api/management/v3", "");
    calls.push(`${init.method} ${path}`);
    const code = status(init.method!, path);
    return new Response(code === 204 ? null : "{}", { status: code });
  }) as typeof deps.fetch;
});

test("create writes the offer, contract definition after its policies", async () => {
  const result = await onEvent({
    RequestType: "Create",
    ResourceProperties: props,
  });
  expect(result.PhysicalResourceId).toBe(`alpha/${DTR_ID}`);
  expect(calls).toEqual([
    `DELETE /contractdefinitions/${DTR_ID}`,
    "POST /policydefinitions",
    "POST /policydefinitions",
    "POST /contractdefinitions",
    "POST /assets",
  ]);
});

test("an existing offer is updated in place", async () => {
  status = (method) => (method === "POST" ? 409 : 204);
  await onEvent({ RequestType: "Update", ResourceProperties: props });
  expect(calls).toContain(`PUT /policydefinitions/${DTR_ID}-access`);
  expect(calls).toContain("PUT /contractdefinitions");
  expect(calls).toContain("PUT /assets");
});

test("delete tolerates a connector that is gone or an asset under agreement", async () => {
  status = (method, path) => (path.startsWith("/assets") ? 409 : 404);
  await expect(
    onEvent({
      RequestType: "Delete",
      PhysicalResourceId: `alpha/${DTR_ID}`,
      ResourceProperties: props,
    }),
  ).resolves.toEqual({ PhysicalResourceId: `alpha/${DTR_ID}` });
  expect(calls).toHaveLength(4);
});

test("a POST answered 404 fails", async () => {
  status = (method) => (method === "POST" ? 404 : 204);
  await expect(
    onEvent({ RequestType: "Create", ResourceProperties: props }),
  ).rejects.toThrow("POST /policydefinitions on alpha returned 404");
});
