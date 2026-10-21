// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Sha256 } from "@smithy/core/checksum";
import { SignatureV4 } from "@smithy/signature-v4";
import { managementApi } from "../lib/portal/management-api";

describe("managementApi", () => {
  const signer = new SignatureV4({
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    region: "eu-central-1",
    service: "execute-api",
    sha256: Sha256,
  });
  const fetchMock = jest.fn();
  beforeAll(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  beforeEach(() => fetchMock.mockReset());

  const api = managementApi(
    "https://abc.execute-api.eu-central-1.amazonaws.com/management/",
    "alpha",
    "eu-central-1",
    signer,
  );

  test("signs the request for the connector's v3 path", async () => {
    fetchMock.mockResolvedValue(new Response('{"@id":"x"}', { status: 200 }));
    const res = await api("POST", "/assets", { "@id": "x" });

    expect(res).toEqual({ status: 200, body: { "@id": "x" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://abc.execute-api.eu-central-1.amazonaws.com/management/alpha/v3/assets",
    );
    expect(init.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/execute-api\/aws4_request/,
    );
    expect(init.headers["x-amz-date"]).toBeDefined();
  });

  test("allowed statuses are returned, others throw", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    expect((await api("GET", "/assets/x", undefined, [404])).status).toBe(404);

    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(api("GET", "/assets/x")).rejects.toThrow(
      "GET /management/alpha/v3/assets/x returned 500: boom",
    );
  });
});
