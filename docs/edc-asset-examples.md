# EDC Asset Examples

Examples of asset definitions for the EDC Management API (`POST /management/<connectorId>/v3/assets`). Each asset is offered in the catalog only once a contract definition selects it with an access and a usage policy. See [Management API Access Patterns](management-api-access-patterns.md) for how to call the API.

Values in angle brackets are placeholders.

## OAuth 2.0-protected HTTP API

The data plane fetches a token with the OAuth 2.0 client-credentials flow before each request to the backend and sends it as a bearer token. `oauth2:clientSecretKey` is the name of a secret in AWS Secrets Manager under the connector's secret prefix (`<deploymentName>/<connectorId>/`), which the data plane can read. The `oauth2:` keys are read literally by EDC, so keep them as shown.

This is the asset the pipeline creates for the Digital Twin Registry when `basyx` is enabled (see the README):

```json
{
  "@context": {
    "@vocab": "https://w3id.org/edc/v0.0.1/ns/",
    "dct": "http://purl.org/dc/terms/",
    "cx-common": "https://w3id.org/catenax/ontology/common#",
    "cx-taxo": "https://w3id.org/catenax/taxonomy#"
  },
  "@type": "Asset",
  "@id": "dataspace-connector-dtr",
  "properties": {
    "dct:type": { "@id": "cx-taxo:DigitalTwinRegistry" },
    "cx-common:version": "3.0"
  },
  "dataAddress": {
    "@type": "DataAddress",
    "type": "HttpData",
    "baseUrl": "<DtrUrl>",
    "proxyPath": "true",
    "proxyQueryParams": "true",
    "proxyMethod": "true",
    "proxyBody": "true",
    "oauth2:tokenUrl": "<TokenUrl>",
    "oauth2:clientId": "<ClientId>",
    "oauth2:clientSecretKey": "<ClientSecretAlias>",
    "oauth2:scope": "<Scope>"
  }
}
```

The placeholders are the outputs `DtrUrl`, `TokenUrl`, `ClientId`, `ClientSecretAlias` and `Scope` of the `<deploymentName>-BaSyx-<BPNL>` stack. The same pattern works for any HTTP backend that accepts client-credentials tokens.

## Battery passport submodel in the BaSyx Submodel Repository

A submodel asset that points at one submodel in the BaSyx Submodel Repository deployed with `services: [dtr, submodelRepository]`. The data plane reaches the repository with the same Cognito client as the DTR. `<submodelIdBase64Url>` is the submodel ID, base64url-encoded without padding, as the AAS API expects.

```json
{
  "@context": {
    "@vocab": "https://w3id.org/edc/v0.0.1/ns/",
    "dct": "http://purl.org/dc/terms/",
    "cx-common": "https://w3id.org/catenax/ontology/common#",
    "cx-taxo": "https://w3id.org/catenax/taxonomy#",
    "aas-semantics": "https://admin-shell.io/aas/3/0/HasSemantics/"
  },
  "@type": "Asset",
  "@id": "<assetId>",
  "properties": {
    "dct:type": { "@id": "cx-taxo:Submodel" },
    "cx-common:version": "3.0",
    "aas-semantics:semanticId": { "@id": "<batteryPassSemanticId>" }
  },
  "dataAddress": {
    "@type": "DataAddress",
    "type": "HttpData",
    "baseUrl": "http://smrepo.<namespace>:5004/submodels/<submodelIdBase64Url>",
    "proxyPath": "true",
    "proxyQueryParams": "true",
    "oauth2:tokenUrl": "<TokenUrl>",
    "oauth2:clientId": "<ClientId>",
    "oauth2:clientSecretKey": "<ClientSecretAlias>",
    "oauth2:scope": "<Scope>"
  }
}
```

`<namespace>` is the host part of `DtrUrl` after `dtr.`. Take `<batteryPassSemanticId>` from the battery passport aspect model version your use case requires (CX-0160). Offer the asset with a usage policy that includes `FrameworkAgreement` `DataExchangeGovernance:1.0` and `UsagePurpose` `cx.circular.dpp:1`.

## Amazon S3 object

An object in the connector's data-plane bucket (output `EdcDataPlaneBucketName` of the connector stack), which the data plane can already read. For any other bucket, grant the data plane's task role `s3:GetObject` on the object.

```json
{
  "@context": { "@vocab": "https://w3id.org/edc/v0.0.1/ns/" },
  "@type": "Asset",
  "@id": "<assetId>",
  "properties": {
    "name": "<name>",
    "contentType": "application/json"
  },
  "dataAddress": {
    "@type": "DataAddress",
    "type": "AmazonS3",
    "region": "<region>",
    "bucketName": "<bucketName>",
    "objectName": "<objectKey>"
  }
}
```

## Policies and contract definition

The DTR offer uses these, and they work as a starting point for the assets above. Policy definitions use the Catena-X policy context:

```json
{
  "@context": [
    "https://w3id.org/dspace/2025/1/odrl-profile.jsonld",
    "https://w3id.org/catenax/2025/9/policy/context.jsonld",
    { "@vocab": "https://w3id.org/edc/v0.0.1/ns/" }
  ],
  "@type": "PolicyDefinition",
  "@id": "<usagePolicyId>",
  "policy": {
    "@type": "Set",
    "permission": [
      {
        "action": "use",
        "constraint": [
          {
            "and": [
              { "leftOperand": "FrameworkAgreement", "operator": "eq", "rightOperand": "DataExchangeGovernance:1.0" },
              { "leftOperand": "UsagePurpose", "operator": "isAnyOf", "rightOperand": "<usagePurpose>" }
            ]
          }
        ]
      }
    ]
  }
}
```

An access policy has the same shape with `"action": "access"` and the single constraint `{ "leftOperand": "Membership", "operator": "eq", "rightOperand": "active" }`. The contract definition links them to the asset:

```json
{
  "@context": { "@vocab": "https://w3id.org/edc/v0.0.1/ns/" },
  "@type": "ContractDefinition",
  "@id": "<contractDefinitionId>",
  "accessPolicyId": "<accessPolicyId>",
  "contractPolicyId": "<usagePolicyId>",
  "assetsSelector": [
    { "operandLeft": "https://w3id.org/edc/v0.0.1/ns/id", "operator": "=", "operandRight": "<assetId>" }
  ]
}
```
