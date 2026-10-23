# Dataspace Connector on AWS - MCP Server

A Model Context Protocol (MCP) server for the Eclipse Dataspace Components (EDC) Management API. It exposes 12 primitives that map closely to the Management API; the consumer and provider workflows live in the agent or skill that uses them, so a new dataspace use case needs no new tool.

| Tool | Purpose |
|---|---|
| `list_connectors` | Discover connector IDs and the Management and DSP base URLs (multi-connector mode). Call it first. |
| `query_resources` | List or query `assets`, `policy_definitions`, `contract_definitions`, `contract_negotiations`, `contract_agreements` or `transfer_processes`. |
| `get_resource` | Read one resource of those types, or the raw `edr` of a transfer. |
| `delete_resource` | Delete an asset, policy definition or contract definition. |
| `create_asset`, `create_policy`, `create_contract_definition` | Publish a data offering. |
| `request_catalog` | Request a provider's catalog over DSP. |
| `initiate_negotiation` | Negotiate a catalog offer; pass its permission, prohibition and obligation through unchanged. |
| `initiate_transfer` | Start a transfer against a finalized agreement. |
| `manage_transfer` | Suspend, resume, complete or terminate a transfer, or every STARTED one with `transfer_process_id="all_started"`. |
| `fetch_data` | Resolve the EDR and fetch the payload from the provider's data plane. |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EDC_MANAGEMENT_URL` | `http://localhost:8080/management` | Management API base URL. Optional in multi-connector mode, where it overrides the discovered URL. |
| `EDC_API_KEY` | | Sent as `X-Api-Key`, for EDC deployments with API-key authentication. |
| `EDC_USE_AWS_IAM` | `false` | Sign requests with SigV4 for API Gateway IAM authorization. |
| `EDC_MULTI_CONNECTOR` | `false` | Discover the connectors of a Dataspace Connector on AWS deployment from CloudFormation. Every tool then requires `connector_id`. |
| `DEPLOYMENT_NAME` | `DataspaceConnector` | The deployment's `deploymentName`, which prefixes its stack names. |
| `AWS_REGION` | `us-east-1` | Region for signing and discovery. |

AWS credentials come from the standard boto3 credential chain and are re-read on every request. They need `execute-api:Invoke`, and in multi-connector mode also `cloudformation:ListStacks` and `cloudformation:DescribeStacks`. Discovery runs once per server process; restart the server to pick up new connectors.

## Usage with Kiro

Dataspace Connector on AWS, in `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "dataspace-connector-on-aws": {
      "command": "uv",
      "args": ["--directory", "<path-to-mcp-directory>", "run", "dataspace-connector-mcp"],
      "env": {
        "EDC_USE_AWS_IAM": "true",
        "EDC_MULTI_CONNECTOR": "true",
        "AWS_REGION": "eu-central-1",
        "AWS_PROFILE": "<profile>"
      }
    }
  }
}
```

Any other EDC: set `EDC_MANAGEMENT_URL` (for example `http://your-edc-host:8182/management`) and, if it uses API-key authentication, `EDC_API_KEY`, instead of the two flags.

## Example

```python
info = list_connectors()
cid = "carbonex"
provider_dsp = f"{info['dsp_base_url']}/provider-connector"

catalog = request_catalog(connector_id=cid, counter_party_address=provider_dsp, counter_party_id="BPNL000000000001")
offer = catalog["dcat:dataset"][0]["odrl:hasPolicy"]
negotiation = initiate_negotiation(
    connector_id=cid,
    counter_party_address=provider_dsp,
    offer_id=offer["@id"],
    asset_id="dataset-id",
    assigner="BPNL000000000001",
    permission=offer.get("odrl:permission"),
    prohibition=offer.get("odrl:prohibition"),
    obligation=offer.get("odrl:obligation"),
)
# Poll get_resource(resource_type="contract_negotiations") until FINALIZED.
transfer = initiate_transfer(
    connector_id=cid, counter_party_address=provider_dsp, contract_id="<contractAgreementId>", transfer_type="HttpData-PULL"
)
# Poll get_resource(resource_type="transfer_processes") until STARTED.
data = fetch_data(connector_id=cid, transfer_process_id=transfer["@id"])
manage_transfer(connector_id=cid, transfer_process_id=transfer["@id"], action="terminate", reason="done")
```

## Development

```bash
uv run pytest
```
