// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ABAC rules and OIDC trust lists for the BaSyx services.
 *
 * Derived from BaSyx Go examples/CatenaXample/security/{dtr,smrepo} at commit
 * 71552c0 and the Catena-X values of eclipse-basyx/charts. Callers are
 * identified by the token's client_id instead of a role claim: the
 * dtrConnector's data plane reads with the per-BPN Edc-Bpn visibility
 * formulas, the provider's writer client has full access like the chart's
 * data_provider role. There is no anonymous access.
 */

import { BasyxService } from "../config/config";
import { READ_SCOPE } from "./names";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const CLIENT_FORMULA = "data_plane_client";
const WRITER_FORMULA = "writer_client";

export interface AccessRuleClients {
  readonly clientId: string;
  readonly writerClientId: string;
}

function isClient(clientId: string): Json {
  return {
    $eq: [{ $attribute: { CLAIMPATH: "/client_id" } }, { $strVal: clientId }],
  };
}

function clientFormulas(clients: AccessRuleClients): Json[] {
  return [
    { name: CLIENT_FORMULA, formula: isClient(clients.clientId) },
    { name: WRITER_FORMULA, formula: isClient(clients.writerClientId) },
  ];
}

function writerRule(objects: string[]): Json {
  return { USEACL: "full", USEOBJECTS: objects, USEFORMULA: WRITER_FORMULA };
}

/** Edc-Bpn equals a field value, or the field is marked PUBLIC_READABLE. */
function bpnOrPublic(field: string): Json {
  return {
    $or: [
      { $eq: [{ $attribute: { CLAIM: "Edc-Bpn" } }, { $field: field }] },
      { $eq: [{ $strVal: "PUBLIC_READABLE" }, { $field: field }] },
    ],
  };
}

function withClient(clientId: string, formula: Json): Json {
  return { $and: [isClient(clientId), formula] };
}

const COMMON_DEFS = {
  DEFATTRIBUTES: [
    { name: "client", attributes: [{ CLAIMPATH: "/client_id" }] },
  ],
  DEFACLS: [
    {
      name: "read",
      acl: { USEATTRIBUTES: "client", RIGHTS: ["READ"], ACCESS: "ALLOW" },
    },
    {
      name: "full",
      acl: {
        USEATTRIBUTES: "client",
        RIGHTS: ["CREATE", "READ", "UPDATE", "DELETE"],
        ACCESS: "ALLOW",
      },
    },
  ],
};

const AAS_SPECIFIC_ASSET_ID =
  "$aasdesc#specificAssetIds[].externalSubjectId.keys[].value";
const AAS_SUBMODEL_SUPPLEMENTAL =
  "$aasdesc#submodelDescriptors[].supplementalSemanticIds[].keys[].value";
const SM_SUPPLEMENTAL = "$sm#supplementalSemanticIds[].keys[].value";

const ALL_ROUTES = { name: "all_routes", objects: [{ ROUTE: "*" }] };

function dtrRules(clients: AccessRuleClients): Json {
  const { clientId } = clients;
  return {
    AllAccessPermissionRules: {
      ...COMMON_DEFS,
      DEFOBJECTS: [
        ALL_ROUTES,
        { name: "description", objects: [{ ROUTE: "/description" }] },
        {
          name: "all_shell_descriptors",
          objects: [{ DESCRIPTOR: '$aasdesc("*")' }],
        },
        {
          name: "asset_links",
          objects: [
            { ROUTE: "/lookup/shells" },
            { ROUTE: "/lookup/shellsByAssetLink" },
          ],
        },
      ],
      DEFFORMULAS: [
        ...clientFormulas(clients),
        {
          name: "aas_bpn_match",
          formula: {
            $eq: [
              { $attribute: { CLAIM: "Edc-Bpn" } },
              { $field: AAS_SPECIFIC_ASSET_ID },
            ],
          },
        },
        {
          name: "aas_bpn_or_public",
          formula: bpnOrPublic(AAS_SPECIFIC_ASSET_ID),
        },
        {
          name: "submodel_descriptor_bpn_or_public",
          formula: bpnOrPublic(AAS_SUBMODEL_SUPPLEMENTAL),
        },
        {
          name: "client_and_aas_bpn_or_public",
          formula: withClient(clientId, bpnOrPublic(AAS_SPECIFIC_ASSET_ID)),
        },
      ],
      rules: [
        writerRule(["all_routes", "all_shell_descriptors"]),
        {
          USEACL: "read",
          USEOBJECTS: ["description"],
          USEFORMULA: CLIENT_FORMULA,
        },
        {
          USEACL: "read",
          USEOBJECTS: ["all_shell_descriptors"],
          USEFORMULA: "client_and_aas_bpn_or_public",
          FILTERLIST: [
            ...[
              "administration",
              "displayName",
              "description",
              "assetKind",
              "assetType",
              "globalAssetId",
              "idShort",
            ].map((f) => ({
              FRAGMENT: `$aasdesc#${f}`,
              USEFORMULA: "aas_bpn_match",
            })),
            {
              FRAGMENT: "$aasdesc#specificAssetIds[]",
              USEFORMULA: "aas_bpn_or_public",
              MATCH: true,
            },
            {
              FRAGMENT: "$aasdesc#specificAssetIds[].externalSubjectId.keys[]",
              USEFORMULA: "aas_bpn_or_public",
              MATCH: true,
            },
            {
              FRAGMENT: "$aasdesc#submodelDescriptors[]",
              USEFORMULA: "submodel_descriptor_bpn_or_public",
              MATCH: true,
            },
            {
              FRAGMENT:
                "$aasdesc#submodelDescriptors[].supplementalSemanticIds[]",
              USEFORMULA: "submodel_descriptor_bpn_or_public",
              MATCH: true,
            },
            {
              FRAGMENT:
                "$aasdesc#submodelDescriptors[].supplementalSemanticIds[].keys[]",
              USEFORMULA: "submodel_descriptor_bpn_or_public",
              MATCH: true,
            },
          ],
        },
        {
          USEACL: "read",
          USEOBJECTS: ["asset_links"],
          USEFORMULA: "client_and_aas_bpn_or_public",
        },
      ],
    },
  };
}

function submodelRepositoryRules(clients: AccessRuleClients): Json {
  const { clientId } = clients;
  return {
    AllAccessPermissionRules: {
      ...COMMON_DEFS,
      DEFOBJECTS: [
        ALL_ROUTES,
        { name: "description", objects: [{ ROUTE: "/description" }] },
        {
          name: "submodel_routes",
          objects: [
            { ROUTE: "/submodels" },
            { ROUTE: "/submodels/*" },
            { ROUTE: "/submodels/*/submodel-elements" },
            { ROUTE: "/submodels/*/submodel-elements/*" },
            { ROUTE: "/query/submodels" },
          ],
        },
      ],
      DEFFORMULAS: [
        ...clientFormulas(clients),
        {
          name: "submodel_bpn_or_public",
          formula: bpnOrPublic(SM_SUPPLEMENTAL),
        },
        {
          name: "client_and_submodel_bpn_or_public",
          formula: withClient(clientId, bpnOrPublic(SM_SUPPLEMENTAL)),
        },
      ],
      rules: [
        writerRule(["all_routes"]),
        {
          USEACL: "read",
          USEOBJECTS: ["description"],
          USEFORMULA: CLIENT_FORMULA,
        },
        {
          USEACL: "read",
          USEOBJECTS: ["submodel_routes"],
          USEFORMULA: "client_and_submodel_bpn_or_public",
          FILTERLIST: [
            {
              FRAGMENT: "$sm#supplementalSemanticIds[]",
              USEFORMULA: "submodel_bpn_or_public",
              MATCH: true,
            },
            {
              FRAGMENT: "$sm#supplementalSemanticIds[].keys[]",
              USEFORMULA: "submodel_bpn_or_public",
              MATCH: true,
            },
          ],
        },
      ],
    },
  };
}

/** ABAC rule file content for a service, as a JSON string. */
export function renderAccessRules(
  service: BasyxService,
  clients: AccessRuleClients,
): string {
  const rules =
    service === "dtr" ? dtrRules(clients) : submodelRepositoryRules(clients);
  return JSON.stringify(rules);
}

/**
 * OIDC trust list content. Cognito client-credentials tokens carry no aud
 * claim, so audience stays empty (BaSyx then skips the audience check) and
 * the read scope is required instead.
 */
export function renderTrustList(issuer: string): string {
  return JSON.stringify([{ issuer, audience: "", scopes: [READ_SCOPE] }]);
}
