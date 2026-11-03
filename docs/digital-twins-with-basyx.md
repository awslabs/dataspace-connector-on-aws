# Digital Twins with Eclipse BaSyx

How a provider publishes a digital twin with a submodel on the BaSyx services of a `basyx` entry, and how a consumer finds and reads it. This is the pull pattern Catena-X digital twin use cases build on. Dataspace Connector on AWS provides the connector, the Digital Twin Registry (DTR) and the Submodel Repository; the aspect models, usage policies and use-case logic are yours.

Values in angle brackets are placeholders. `<ManagementApiUrl>` is an output of the `<deploymentName>-SharedInfra` stack; the other outputs belong to the `<deploymentName>-BaSyx-<BPNL>` stack. AAS IDs in URLs are base64url-encoded without padding, shown as `<...B64>`.

## Provider

### 1. Get a writer token

The pipeline creates the services empty. Your applications write to them through the management API, so the `managementApiPrincipals` that manage the connectors can also write to BaSyx. Each request carries two credentials:

1. A SigV4 signature for the management API, like any other management call ([Management API Access Patterns](management-api-access-patterns.md)).
2. A Cognito token of the BaSyx writer client in the `X-BaSyx-Authorization` header. API Gateway uses `Authorization` for the SigV4 signature and passes this header on to BaSyx as `Authorization`.

The writer client secret is in the Secrets Manager secret `WriterClientSecretArn`:

```bash
curl -s -u "<WriterClientId>:<writer client secret>" -d grant_type=client_credentials \
  -d scope=dataspace-connector-basyx/read "<TokenUrl>"
```

The writer has full access to both services, like the `data_provider` role in the [Catena-X values of the BaSyx Helm chart](https://github.com/eclipse-basyx/charts). API Gateway limits a request to 10 MB and 29 seconds, which matters for large submodel uploads.

### 2. Write the submodel

`POST <ManagementApiUrl>/basyx/<BPNL>/smrepo/submodels`

```json
{
  "modelType": "Submodel",
  "id": "<submodelId>",
  "idShort": "<submodelIdShort>",
  "kind": "Instance",
  "semanticId": { "type": "ExternalReference", "keys": [{ "type": "GlobalReference", "value": "<semanticId>" }] },
  "supplementalSemanticIds": [
    { "type": "ExternalReference", "keys": [{ "type": "GlobalReference", "value": "<consumerBPNL>" }] }
  ],
  "submodelElements": [
    { "modelType": "Property", "idShort": "<propertyIdShort>", "valueType": "xs:string", "value": "<value>" }
  ]
}
```

The Submodel Repository returns a submodel only to a reader whose `Edc-Bpn` matches one of its `supplementalSemanticIds`, so list each consumer BPNL that may read it, or `PUBLIC_READABLE` for any consumer with an agreement. The data plane sends the consumer's BPNL from the contract agreement as `Edc-Bpn`.

### 3. Offer the submodels as one EDC asset

Create one asset per use case with the management API of the connector that offers it, pointing `baseUrl` at `.../smrepo`. All submodels of the use case share it; the shell descriptor's `href` selects the submodel. The asset JSON is in [EDC Asset Examples](edc-asset-examples.md#submodels-in-the-basyx-submodel-repository).

### 4. Register the shell descriptor

`POST <ManagementApiUrl>/basyx/<BPNL>/dtr/api/v3/shell-descriptors`, or an array of descriptors to `.../bulk/shell-descriptors` (asynchronous, poll the returned `Location`).

```json
{
  "id": "<shellId>",
  "idShort": "<shellIdShort>",
  "specificAssetIds": [
    {
      "name": "manufacturerPartId",
      "value": "<partId>",
      "externalSubjectId": { "type": "ExternalReference", "keys": [{ "type": "GlobalReference", "value": "<consumerBPNL>" }] }
    }
  ],
  "submodelDescriptors": [
    {
      "id": "<submodelId>",
      "idShort": "<submodelIdShort>",
      "semanticId": { "type": "ExternalReference", "keys": [{ "type": "GlobalReference", "value": "<semanticId>" }] },
      "supplementalSemanticIds": [
        { "type": "ExternalReference", "keys": [{ "type": "GlobalReference", "value": "<consumerBPNL>" }] }
      ],
      "endpoints": [
        {
          "interface": "SUBMODEL-3.0",
          "protocolInformation": {
            "href": "<providerDataPlanePublicUrl>/submodels/<submodelIdB64>",
            "endpointProtocol": "HTTP",
            "endpointProtocolVersion": ["1.1"],
            "subprotocol": "DSP",
            "subprotocolBody": "id=<assetId>;dspEndpoint=<providerDspUrl>",
            "subprotocolBodyEncoding": "plain",
            "securityAttributes": [{ "type": "NONE", "key": "NONE", "value": "NONE" }]
          }
        }
      ]
    }
  ]
}
```

- **Visibility:** the DTR filters by `Edc-Bpn` the same way. A consumer sees the shell only when its BPNL (or `PUBLIC_READABLE`) is an `externalSubjectId`, and sees a submodel descriptor only when it is listed in that descriptor's `supplementalSemanticIds`.
- **`href`:** the provider data plane URL plus `submodels/<submodelIdB64>`; the data plane appends this path to the asset's `baseUrl`.
- **`subprotocolBody`:** must name the asset ID from step 3 and the DSP endpoint of the connector that offers it. Nothing checks that they match, so a typo only shows when a consumer negotiates.

## Consumer

Each step runs through the consumer's own connector. The [MCP server](../mcp/README.md) tools `request_catalog`, `initiate_negotiation`, `initiate_transfer` and `fetch_data` cover all of them.

1. **Open the DTR.** Request the provider's catalog filtered on `dct:type` `cx-taxo:DigitalTwinRegistry`, negotiate the `dataspace-connector-dtr` offer and start an `HttpData-PULL` transfer. Reuse the agreement for later lookups. For many twins, page through `GET shell-descriptors?limit=1000` or `POST lookup/shellsByAssetLink?createdAfter=<RFC 3339>` instead of reading descriptors one by one.
2. **Find the twin.** Through the transfer's data plane endpoint, call `lookup/shells?assetIds=<assetIdsB64>`, where the parameter is the base64url-encoded JSON of `{"name": "manufacturerPartId", "value": "<partId>"}`. `POST lookup/shellsByAssetLink` with a JSON array of the same objects works too.
3. **Read the descriptor.** Call `shell-descriptors/<shellIdB64>` and take `id` and `dspEndpoint` from the submodel descriptor's `subprotocolBody`.
4. **Negotiate the submodel asset once.** Request the catalog at that `dspEndpoint` filtered on that asset ID, negotiate the offer exactly as the catalog returns it and start one transfer. Reuse its EDR for every `href` with the same asset ID.
5. **Pull it.** Call the `href` path plus `/$value` for the value-only view. For bulk pulls, `submodels/$value?semanticId=<referenceB64>&limit=` pages through every submodel you may read.

BaSyx denials and paths the AAS v3 API doesn't define return 4xx from BaSyx, which the data plane reports as a 500. [Submodels at Scale](submodels-at-scale.md) covers sizing and an AWS-native alternative to BaSyx.
