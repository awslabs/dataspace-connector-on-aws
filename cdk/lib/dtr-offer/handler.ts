// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DtrOffer custom resource: the Digital Twin Registry (DTR) offer of a BPNL's
 * BaSyx deployment on its dtrConnector. One asset, an access and a usage
 * policy and a contract definition, all under fixed IDs, written through the
 * connector's management API on the internal load balancer.
 *
 * - Create and Update write the offer. A changed ConnectorId gets a new
 *   physical id, so CloudFormation then deletes the offer from the old
 *   connector.
 * - Delete removes it. A connector that is already gone answers 404.
 *
 * The physical id is `<ConnectorId>/<DTR_ID>`.
 */

export const DTR_ID = "dataspace-connector-dtr";
const ACCESS_POLICY_ID = `${DTR_ID}-access`;
const USAGE_POLICY_ID = `${DTR_ID}-usage`;

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

export interface DtrOfferProperties {
  /** `http://<internal ALB>:<management port>` */
  readonly ManagementUrl: string;
  readonly ConnectorId: string;
  readonly DtrUrl: string;
  readonly TokenUrl: string;
  readonly ClientId: string;
  readonly Scope: string;
  readonly ClientSecretAlias: string;
}

export interface ResourceEvent {
  readonly RequestType: "Create" | "Update" | "Delete";
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: DtrOfferProperties;
}

type Request = (
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: object,
) => Promise<number>;

/** Seam for tests. */
export const deps = {
  fetch: (url: string, init: RequestInit) => fetch(url, init),
};

export async function onEvent(
  event: ResourceEvent,
): Promise<{ PhysicalResourceId: string }> {
  const props = event.ResourceProperties;
  const api = managementApi(props);
  if (event.RequestType === "Delete") {
    await remove(api, props.ConnectorId);
    return { PhysicalResourceId: event.PhysicalResourceId! };
  }
  await write(api, props);
  return { PhysicalResourceId: `${props.ConnectorId}/${DTR_ID}` };
}

/**
 * Tractus-X rejects changes to a policy that a contract definition
 * references, so the contract definition goes first and comes back last.
 * Existing agreements are not affected.
 */
async function write(api: Request, props: DtrOfferProperties): Promise<void> {
  const definitions = offer(props);
  await api("DELETE", `/contractdefinitions/${DTR_ID}`);
  await upsert(api, "/policydefinitions", definitions.accessPolicy, true);
  await upsert(api, "/policydefinitions", definitions.usagePolicy, true);
  await upsert(api, "/contractdefinitions", definitions.contractDefinition);
  await upsert(api, "/assets", definitions.asset);
}

async function remove(api: Request, connectorId: string): Promise<void> {
  await api("DELETE", `/contractdefinitions/${DTR_ID}`);
  if ((await api("DELETE", `/assets/${DTR_ID}`)) === 409) {
    console.warn(
      `${connectorId}: asset ${DTR_ID} is referenced by a contract agreement and stays; it is no longer offered`,
    );
  }
  await api("DELETE", `/policydefinitions/${USAGE_POLICY_ID}`);
  await api("DELETE", `/policydefinitions/${ACCESS_POLICY_ID}`);
}

/** POST, and PUT when the ID already exists (409). */
async function upsert(
  api: Request,
  collection: string,
  body: { "@id": string },
  idInPath = false,
): Promise<void> {
  if ((await api("POST", collection, body)) !== 409) return;
  await api(
    "PUT",
    idInPath ? `${collection}/${body["@id"]}` : collection,
    body,
  );
}

/** Throws unless 2xx, 409 on POST or DELETE, or 404 on DELETE; returns the status. */
function managementApi(props: DtrOfferProperties): Request {
  const base = `${props.ManagementUrl}/${props.ConnectorId}/api/management/v3`;
  return async (method, path, body) => {
    const res = await deps.fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const allowed =
      res.ok ||
      (res.status === 409 && method !== "PUT") ||
      (res.status === 404 && method === "DELETE");
    if (!allowed) {
      throw new Error(
        `${method} ${path} on ${props.ConnectorId} returned ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    return res.status;
  };
}

export function offer(props: DtrOfferProperties) {
  const policy = (
    id: string,
    action: string,
    constraint: object,
  ): { "@id": string; [key: string]: unknown } => ({
    "@context": POLICY_CONTEXT,
    "@type": "PolicyDefinition",
    "@id": id,
    policy: {
      "@type": "Set",
      permission: [{ action, constraint: [constraint] }],
    },
  });
  return {
    accessPolicy: policy(ACCESS_POLICY_ID, "access", {
      leftOperand: "Membership",
      operator: "eq",
      rightOperand: "active",
    }),
    usagePolicy: policy(USAGE_POLICY_ID, "use", {
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
    }),
    contractDefinition: {
      "@context": EDC_CONTEXT,
      "@type": "ContractDefinition",
      "@id": DTR_ID,
      accessPolicyId: ACCESS_POLICY_ID,
      contractPolicyId: USAGE_POLICY_ID,
      assetsSelector: [
        { operandLeft: `${EDC_NS}id`, operator: "=", operandRight: DTR_ID },
      ],
    },
    asset: {
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
        baseUrl: props.DtrUrl,
        proxyPath: "true",
        proxyQueryParams: "true",
        proxyMethod: "true",
        proxyBody: "true",
        // EDC reads these keys literally (Oauth2DataAddressSchema).
        "oauth2:tokenUrl": props.TokenUrl,
        "oauth2:clientId": props.ClientId,
        "oauth2:clientSecretKey": props.ClientSecretAlias,
        "oauth2:scope": props.Scope,
      },
    },
  };
}
