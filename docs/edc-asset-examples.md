# EDC Asset Examples

Examples of asset definitions for the EDC Management API (`POST /management/<connectorId>/v3/assets`). Each asset is offered in the catalog only once a contract definition selects it with an access and a usage policy; the [Tractus-X policy walkthrough](https://github.com/eclipse-tractusx/tractusx-edc/blob/main/docs/usage/management-api-walkthrough/02_policies.md) shows the Catena-X policies. See [Management API Access Patterns](management-api-access-patterns.md) for how to call the API.

Values in angle brackets are placeholders.

## OAuth 2.0-protected HTTP API

The data plane fetches a token with the OAuth 2.0 client-credentials flow before each request to the backend and sends it as a bearer token. `oauth2:clientSecretKey` is the name of a secret in AWS Secrets Manager under the connector's secret prefix (`<deploymentName>/<connectorId>/`), which the data plane can read. The `oauth2:` keys are read literally by EDC, so keep them as shown.

This is the asset the pipeline creates for the Digital Twin Registry of a `basyx` entry (see the README):

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

## Submodels in the BaSyx Submodel Repository

One asset for all submodels of a use case in the BaSyx Submodel Repository deployed with `services: [dtr, submodelRepository]`. Each shell descriptor's `href` selects one submodel (`<dataPlanePublicUrl>/submodels/<submodelIdB64>`), and BaSyx returns a submodel only to the BPNLs in its `supplementalSemanticIds`. The data plane reaches the repository with the same Cognito client as the DTR. See [Submodels at Scale](submodels-at-scale.md).

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
    "aas-semantics:semanticId": { "@id": "<semanticId>" }
  },
  "dataAddress": {
    "@type": "DataAddress",
    "type": "HttpData",
    "baseUrl": "http://<albHost>:5004/basyx/<BPNL>/smrepo",
    "proxyPath": "true",
    "proxyQueryParams": "true",
    "oauth2:tokenUrl": "<TokenUrl>",
    "oauth2:clientId": "<ClientId>",
    "oauth2:clientSecretKey": "<ClientSecretAlias>",
    "oauth2:scope": "<Scope>"
  }
}
```

`<albHost>` is the host part of `DtrUrl`. Take `<semanticId>` from the aspect model your use case standard requires, and offer the asset with the usage purpose that standard defines. [Digital Twins with Eclipse BaSyx](digital-twins-with-basyx.md) shows how the submodel and its shell descriptor are written and how a consumer reaches the asset.

## API key-protected HTTP API

For a backend that checks a static key header, such as the AWS-native submodel service in [Submodels at Scale](submodels-at-scale.md#aws-native-submodel-service). The data plane reads the key from the secret `secretName` under the connector's secret prefix and sends it in the header `authKey` on every request.

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
    "type": "HttpData",
    "baseUrl": "<ApiUrl>",
    "proxyPath": "true",
    "proxyQueryParams": "true",
    "authKey": "x-api-key",
    "secretName": "<secretName>"
  }
}
```

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
