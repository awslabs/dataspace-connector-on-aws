// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ABAC rules and OIDC trust lists for the BaSyx services.
 *
 * Derived from BaSyx Go examples/CatenaXample/security/{dtr,smrepo} at commit
 * 71552c0 with three changes: the caller is identified by the token's
 * client_id (the dtrConnector's data plane), only READ is granted, and there
 * is no anonymous access. The per-BPN visibility formulas on the Edc-Bpn
 * header are kept unchanged.
 */

import { BasyxService } from "../config/config";
import { READ_SCOPE } from "./names";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const CLIENT_FORMULA = "data_plane_client";

function isClient(clientId: string): Json {
  return {
    $eq: [{ $attribute: { CLAIMPATH: "/client_id" } }, { $strVal: clientId }],
  };
}

function clientFormula(clientId: string): Json {
  return { name: CLIENT_FORMULA, formula: isClient(clientId) };
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
    { name: "data_plane", attributes: [{ CLAIMPATH: "/client_id" }] },
  ],
  DEFACLS: [
    {
      name: "read",
      acl: { USEATTRIBUTES: "data_plane", RIGHTS: ["READ"], ACCESS: "ALLOW" },
    },
  ],
};

const AAS_SPECIFIC_ASSET_ID =
  "$aasdesc#specificAssetIds[].externalSubjectId.keys[].value";
const AAS_SUBMODEL_SUPPLEMENTAL =
  "$aasdesc#submodelDescriptors[].supplementalSemanticIds[].keys[].value";
const SM_SUPPLEMENTAL = "$sm#supplementalSemanticIds[].keys[].value";

function dtrRules(clientId: string): Json {
  return {
    AllAccessPermissionRules: {
      ...COMMON_DEFS,
      DEFOBJECTS: [
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
        clientFormula(clientId),
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

function submodelRepositoryRules(clientId: string): Json {
  return {
    AllAccessPermissionRules: {
      ...COMMON_DEFS,
      DEFOBJECTS: [
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
        clientFormula(clientId),
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
  options: { clientId: string },
): string {
  const rules =
    service === "dtr"
      ? dtrRules(options.clientId)
      : submodelRepositoryRules(options.clientId);
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
