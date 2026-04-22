# Dataspace Connector on AWS - MCP Server

A Model Context Protocol (MCP) server for interacting with the Eclipse Dataspace Components (EDC) Management API.

## Features

This MCP server provides 15 tools covering the full EDC Management API workflow:

### Provider-side tools
- **create_asset** - Create a new asset with data address
- **create_policy_definition** - Create a new policy definition with ODRL rules
- **create_contract_definition** - Create a contract definition linking assets to policies

### Consumer-side tools
- **request_catalog** - Request the catalog from another EDC connector to discover available datasets
- **initiate_contract_negotiation** - Start a contract negotiation with a provider (passes full policy from catalog)
- **get_contract_negotiation** - Get the full contract negotiation object including state and agreement ID
- **get_contract_agreement** - Retrieve a finalized contract agreement
- **initiate_transfer** - Start a data transfer using a contract agreement
- **get_transfer_process** - Get the full transfer process object including state and error details
- **get_edr_data_address** - Get the endpoint data reference (EDR) for an active transfer
- **initiate_edr_negotiation** - Combined negotiation + transfer in one call (shortcut for the full consumer flow)

### Query tools
- **query_assets** - List/search assets with filtering and pagination
- **query_contract_negotiations** - List/search contract negotiations
- **query_transfer_processes** - List/search transfer processes
- **query_contract_agreements** - List/search contract agreements

## Installation

```bash
# Using uv (recommended)
uv pip install -e .

# Or using pip
pip install -e .
```

## Configuration

Set these environment variables:

```bash
# EDC Management API endpoint (default: http://localhost:8080/management)
export EDC_MANAGEMENT_URL="https://your-edc-instance.com/management"

# Required: API key for EDC authentication
export EDC_API_KEY="your-api-key"

# Optional: Enable AWS IAM authentication for API Gateway
export EDC_USE_AWS_IAM="true"
export AWS_REGION="us-east-1"
```

### AWS IAM Authentication

When deploying EDC behind Amazon API Gateway with IAM authorization, you need both:
1. **X-Api-Key header** - For EDC authentication (always required, even if set to an empty value)
2. **AWS SigV4 signing** - For API Gateway authorization (when `EDC_USE_AWS_IAM=true`)

The server uses boto3's standard credential chain:
- Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- AWS credentials file (`~/.aws/credentials`)
- AWS SSO credentials
- IAM role (if running on EC2/ECS/Lambda)

Credentials are refreshed automatically on each request, so temporary credentials (IAM roles, SSO) work without restarting the server.

Make sure your AWS credentials have `execute-api:Invoke` permission for the API Gateway.

## Usage with Kiro

### Local Development (no AWS IAM)

Add to your `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "dataspace-connector-on-aws": {
      "command": "uv",
      "args": [
        "--directory",
        "<path-to-mcp-directory>",
        "run",
        "dataspace-connector-mcp"
      ],
      "env": {
        "EDC_MANAGEMENT_URL": "http://localhost:8080/management",
        "EDC_API_KEY": "password"
      }
    }
  }
}
```

### AWS Deployment (with API Gateway IAM)

```json
{
  "mcpServers": {
    "dataspace-connector-on-aws": {
      "command": "uv",
      "args": [
        "--directory",
        "<path-to-mcp-directory>",
        "run",
        "dataspace-connector-mcp"
      ],
      "env": {
        "EDC_MANAGEMENT_URL": "https://<api-id>.execute-api.<aws-region>.amazonaws.com/management",
        "EDC_API_KEY": "password",
        "EDC_USE_AWS_IAM": "true",
        "AWS_REGION": "us-east-1",
        "AWS_PROFILE": ""
      }
    }
  }
}
```

## Example Usage

### End-to-end consumer flow

```python
# 1. Discover available datasets from a provider
catalog = request_catalog(
    counter_party_address="https://provider.example.com/protocol",
    counter_party_id="BPNL000000000001"
)

# 2. Extract offer details from catalog and negotiate a contract
# The permission/prohibition/obligation must be passed through exactly from the catalog offer
offer = catalog["dcat:dataset"][0]["odrl:hasPolicy"]
negotiation = initiate_contract_negotiation(
    counter_party_address="https://provider.example.com/protocol",
    offer_id=offer["@id"],
    asset_id="dataset-id",
    assigner="BPNL000000000001",
    permission=[offer["odrl:permission"]],
    prohibition=offer["odrl:prohibition"],
    obligation=offer["odrl:obligation"]
)

# 3. Poll until negotiation is finalized
state = get_contract_negotiation(negotiation_id=negotiation["@id"])

# 4. Retrieve the contract agreement (get agreement ID from negotiation query)
agreement = get_contract_agreement(agreement_id="<agreement-id>")

# 5. Initiate a data transfer
transfer = initiate_transfer(
    counter_party_address="https://provider.example.com/protocol",
    contract_id=agreement["@id"],
    transfer_type="HttpData-PULL"
)

# 6. Poll until transfer is started
state = get_transfer_process(transfer_process_id=transfer["@id"])

# 7. Get the endpoint data reference with access token
edr = get_edr_data_address(transfer_process_id=transfer["@id"])
```

### Create a data offering (provider side)

```python
# 1. Create an access policy (controls catalog visibility)
create_policy_definition(
    policy_id="my-access-policy",
    policy={
        "@type": "Set",
        "permission": [{
            "action": "access",
            "constraint": {
                "leftOperand": "Membership",
                "operator": "eq",
                "rightOperand": "active"
            }
        }]
    }
)

# 2. Create a usage policy (controls contract negotiation)
create_policy_definition(
    policy_id="my-usage-policy",
    policy={
        "@type": "Set",
        "permission": [{
            "action": "use",
            "constraint": [{
                "and": [
                    {"leftOperand": "FrameworkAgreement", "operator": "eq", "rightOperand": "DataExchangeGovernance:1.0"},
                    {"leftOperand": "UsagePurpose", "operator": "isAnyOf", "rightOperand": "cx.core.industrycore:1"}
                ]
            }]
        }]
    }
)

# 3. Create an asset
create_asset(
    asset_id="my-dataset",
    properties={
        "name": "Sample Dataset",
        "description": "A shared dataset",
        "contentType": "application/json"
    },
    data_address={
        "type": "HttpData",
        "baseUrl": "https://example.com/api/data"
    }
)

# 4. Create contract definition linking asset to both policies
create_contract_definition(
    contract_definition_id="my-contract-def",
    access_policy_id="my-access-policy",
    contract_policy_id="my-usage-policy",
    assets_selector=[{
        "operandLeft": "https://w3id.org/edc/v0.0.1/ns/id",
        "operator": "=",
        "operandRight": "my-dataset"
    }]
)
```

### Query existing resources

```python
# List all assets
query_assets(limit=10)

# Find finalized negotiations
query_contract_negotiations(filter_expression=[{
    "operandLeft": "state",
    "operator": "=",
    "operandRight": "FINALIZED"
}])

# List active transfers
query_transfer_processes(filter_expression=[{
    "operandLeft": "state",
    "operator": "=",
    "operandRight": "STARTED"
}])
```

## Development

Run the server directly:

```bash
python server.py
```
