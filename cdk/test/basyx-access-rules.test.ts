// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { renderAccessRules, renderTrustList } from "../lib/basyx/access-rules";
import { BASYX_SERVICES } from "../lib/config/config";

const CLIENT_ID = "abc123client";
const WRITER_ID = "writer456client";

/** Collects every value under the given key anywhere in a JSON tree. */
function collect(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) node.forEach((n) => collect(n, key, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      collect(v, key, out);
    }
  }
  return out;
}

describe.each(BASYX_SERVICES)("access rules: %s", (service) => {
  const text = renderAccessRules(service, {
    clientId: CLIENT_ID,
    writerClientId: WRITER_ID,
  });
  const rules = JSON.parse(text);
  const { DEFACLS, DEFFORMULAS } = rules.AllAccessPermissionRules;
  const formulas = new Map<string, unknown>(
    DEFFORMULAS.map((f: { name: string; formula: unknown }) => [
      f.name,
      JSON.stringify(f.formula),
    ]),
  );
  const rightsOf = (acl: string) =>
    DEFACLS.find((a: { name: string }) => a.name === acl).acl.RIGHTS;

  test("only the writer client gets write rights", () => {
    for (const rule of rules.AllAccessPermissionRules.rules) {
      const formula = formulas.get(rule.USEFORMULA) as string;
      if (rightsOf(rule.USEACL).some((r: string) => r !== "READ")) {
        expect(formula).toContain(`{"$strVal":"${WRITER_ID}"}`);
        expect(formula).not.toContain(CLIENT_ID);
      }
    }
  });

  test("has no anonymous access", () => {
    expect(collect(rules, "GLOBAL")).toEqual([]);
    expect(text).not.toContain("ANONYMOUS");
  });

  test("every rule requires a known client", () => {
    for (const rule of rules.AllAccessPermissionRules.rules) {
      const formula = formulas.get(rule.USEFORMULA) as string;
      expect(formula).toContain('{"CLAIMPATH":"/client_id"}');
      expect(formula.includes(CLIENT_ID) || formula.includes(WRITER_ID)).toBe(
        true,
      );
    }
  });

  test("keeps the Edc-Bpn visibility formulas", () => {
    expect(text).toContain('{"CLAIM":"Edc-Bpn"}');
    expect(text).toContain("PUBLIC_READABLE");
  });
});

test("trust list requires the read scope and leaves audience empty", () => {
  const list = JSON.parse(renderTrustList("https://issuer.example"));
  expect(list).toEqual([
    {
      issuer: "https://issuer.example",
      audience: "",
      scopes: ["dataspace-connector-basyx/read"],
    },
  ]);
});
