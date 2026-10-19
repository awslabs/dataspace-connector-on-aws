// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { renderAccessRules, renderTrustList } from "../lib/basyx/access-rules";
import { BASYX_SERVICES } from "../lib/config/config";

const CLIENT_ID = "abc123client";

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
  const text = renderAccessRules(service, { clientId: CLIENT_ID });
  const rules = JSON.parse(text);

  test("grants READ only", () => {
    const rights = collect(rules, "RIGHTS").flat();
    expect(new Set(rights)).toEqual(new Set(["READ"]));
  });

  test("has no anonymous access", () => {
    expect(collect(rules, "GLOBAL")).toEqual([]);
    expect(text).not.toContain("ANONYMOUS");
  });

  test("every rule requires the data-plane client", () => {
    const formulas = new Map<string, unknown>(
      rules.AllAccessPermissionRules.DEFFORMULAS.map(
        (f: { name: string; formula: unknown }) => [f.name, f.formula],
      ),
    );
    for (const rule of rules.AllAccessPermissionRules.rules) {
      const formula = JSON.stringify(formulas.get(rule.USEFORMULA));
      expect(formula).toContain('{"CLAIMPATH":"/client_id"}');
      expect(formula).toContain(`{"$strVal":"${CLIENT_ID}"}`);
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
