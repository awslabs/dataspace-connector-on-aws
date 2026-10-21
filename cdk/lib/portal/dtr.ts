// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Digital Twin Registry (DTR) offer on a BPNL's dtrConnector: one asset,
 * an access and a usage policy, and a contract definition, all under fixed IDs.
 *
 * ensureDtr writes them only when their definition hash differs from the one
 * stored on the asset, so a run with no changes costs one GET. removeDtr
 * deletes them from connectors that are not (or no longer) the dtrConnector.
 */

import { createHash } from "crypto";
import { ManagementRequest } from "./management-api";

export const DTR_ID = "dataspace-connector-dtr";
export const DTR_ACCESS_POLICY_ID = `${DTR_ID}-access`;
export const DTR_USAGE_POLICY_ID = `${DTR_ID}-usage`;
export const DTR_HASH_PROPERTY = "dataspaceConnectorDefinitionHash";

const EDC_NS = "https://w3id.org/edc/v0.0.1/ns/";
const EDC_CONTEXT = {
  "@vocab": EDC_NS,
  dct: "http://purl.org/dc/terms/",
  "cx-common": "https://w3id.org/catenax/ontology/common#",
  "cx-taxo": "https://w3id.org/catenax/taxonomy#",
};
const POLICY_CONTEXT = [
  "https://w3id.org/dspace/2025/1/odrl-profile.jsonld",
  "https://w3id.org/catenax/2025/9/policy/context.jsonld",
  { "@vocab": EDC_NS },
];

/** Outputs of a BPNL's BasyxStack that the DTR offer is built from. */
export interface BasyxOutputs {
  readonly dtrUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly scope: string;
  readonly clientSecretAlias: string;
}

export interface DtrDefinition {
  readonly accessPolicy: object;
  readonly usagePolicy: object;
  readonly contractDefinition: object;
  readonly asset: object;
  readonly hash: string;
}

/** Builds the four EDC objects; the asset carries the hash over all four. */
export function buildDtrDefinition(outputs: BasyxOutputs): DtrDefinition {
  const accessPolicy = {
    "@context": POLICY_CONTEXT,
    "@type": "PolicyDefinition",
    "@id": DTR_ACCESS_POLICY_ID,
    policy: {
      "@type": "Set",
      permission: [
        {
          action: "access",
          constraint: [
            {
              leftOperand: "Membership",
              operator: "eq",
              rightOperand: "active",
            },
          ],
        },
      ],
    },
  };
  const usagePolicy = {
    "@context": POLICY_CONTEXT,
    "@type": "PolicyDefinition",
    "@id": DTR_USAGE_POLICY_ID,
    policy: {
      "@type": "Set",
      permission: [
        {
          action: "use",
          constraint: [
            {
              and: [
                {
                  leftOperand: "FrameworkAgreement",
                  operator: "eq",
                  rightOperand: "DataExchangeGovernance:1.0",
                },
                {
                  leftOperand: "UsagePurpose",
                  operator: "isAnyOf",
                  rightOperand: "cx.core.digitalTwinRegistry:1",
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const contractDefinition = {
    "@context": EDC_CONTEXT,
    "@type": "ContractDefinition",
    "@id": DTR_ID,
    accessPolicyId: DTR_ACCESS_POLICY_ID,
    contractPolicyId: DTR_USAGE_POLICY_ID,
    assetsSelector: [
      { operandLeft: `${EDC_NS}id`, operator: "=", operandRight: DTR_ID },
    ],
  };
  const assetWithoutHash = {
    "@context": EDC_CONTEXT,
    "@type": "Asset",
    "@id": DTR_ID,
    properties: {
      "dct:type": { "@id": "cx-taxo:DigitalTwinRegistry" },
      "cx-common:version": "3.0",
    },
    dataAddress: {
      "@type": "DataAddress",
      type: "HttpData",
      baseUrl: outputs.dtrUrl,
      proxyPath: "true",
      proxyQueryParams: "true",
      proxyMethod: "true",
      proxyBody: "true",
      // EDC reads these keys literally (Oauth2DataAddressSchema).
      "oauth2:tokenUrl": outputs.tokenUrl,
      "oauth2:clientId": outputs.clientId,
      "oauth2:clientSecretKey": outputs.clientSecretAlias,
      "oauth2:scope": outputs.scope,
    },
  };

  // The definition is built by this code, so its key order is stable.
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        accessPolicy,
        usagePolicy,
        contractDefinition,
        assetWithoutHash,
      ]),
    )
    .digest("hex");

  return {
    accessPolicy,
    usagePolicy,
    contractDefinition,
    asset: {
      ...assetWithoutHash,
      privateProperties: { [DTR_HASH_PROPERTY]: hash },
    },
    hash,
  };
}

/**
 * Creates or updates the DTR offer when its stored hash differs. Write order is
 * policies, contract definition, asset: the asset carries the hash, so a run
 * that fails partway leaves no matching hash and the next run retries.
 * Tractus-X rejects writes to a policy that a contract definition references,
 * so the contract definition is deleted first and recreated after; until then
 * the DTR is missing from the catalog. Existing agreements are not affected.
 * Returns true when it wrote.
 */
export async function ensureDtr(
  api: ManagementRequest,
  definition: DtrDefinition,
): Promise<boolean> {
  const current = await api("GET", `/assets/${DTR_ID}`, undefined, [404]);
  if (current.status === 200 && storedHash(current.body) === definition.hash) {
    return false;
  }

  await api("DELETE", `/contractdefinitions/${DTR_ID}`, undefined, [404]);
  await upsert(api, "/policydefinitions", definition.accessPolicy, true);
  await upsert(api, "/policydefinitions", definition.usagePolicy, true);
  await upsert(api, "/contractdefinitions", definition.contractDefinition);
  await upsert(api, "/assets", definition.asset);
  return true;
}

/**
 * Deletes the DTR offer, contract definition first so no offer points at the
 * asset while it goes. The access policy is created first and deleted last, so
 * its absence means nothing is left: one GET when there is nothing to do.
 * Returns true when it deleted.
 */
export async function removeDtr(
  api: ManagementRequest,
  warn: (msg: string) => void,
): Promise<boolean> {
  const probe = await api(
    "GET",
    `/policydefinitions/${DTR_ACCESS_POLICY_ID}`,
    undefined,
    [404],
  );
  if (probe.status === 404) return false;

  await api("DELETE", `/contractdefinitions/${DTR_ID}`, undefined, [404]);
  const asset = await api("DELETE", `/assets/${DTR_ID}`, undefined, [404, 409]);
  if (asset.status === 409) {
    warn(
      `asset ${DTR_ID} is referenced by a contract agreement and stays; it is no longer offered`,
    );
  }
  await api(
    "DELETE",
    `/policydefinitions/${DTR_USAGE_POLICY_ID}`,
    undefined,
    [404],
  );
  await api(
    "DELETE",
    `/policydefinitions/${DTR_ACCESS_POLICY_ID}`,
    undefined,
    [404],
  );
  return true;
}

/** POST, and PUT when the ID already exists (409). */
async function upsert(
  api: ManagementRequest,
  collection: string,
  body: object,
  idInPath = false,
): Promise<void> {
  const created = await api("POST", collection, body, [409]);
  if (created.status !== 409) return;
  const id = (body as { "@id": string })["@id"];
  await api("PUT", idInPath ? `${collection}/${id}` : collection, body);
}

/** The hash stored in an asset GET response's private properties. */
function storedHash(asset: unknown): string | undefined {
  const props = (asset as { privateProperties?: Record<string, unknown> })
    ?.privateProperties;
  if (!props) return undefined;
  const value = props[DTR_HASH_PROPERTY];
  return typeof value === "string" ? value : undefined;
}
