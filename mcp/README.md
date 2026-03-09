# Dataspace Connector on AWS - MCP Server

A Model Context Protocol (MCP) server for interacting with the Eclipse Dataspace Components (EDC) Management API.

## Features

This MCP server provides 4 tools for managing EDC resources:

1. **create_asset** - Create a new asset with data address
2. **create_policy_definition** - Create a new policy definition with ODRL rules
3. **create_contract_definition** - Create a contract definition linking assets to policies
4. **request_catalog** - Request the catalog from another EDC connector to discover available datasets

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

### Discover available datasets from a provider

```python
# Request catalog from another connector
request_catalog(
    counter_party_address="https://provider.example.com/dsp",
    counter_party_id="BPNL000000000001"
)
```

### Create a data offering step by step

```python
# 1. First create a policy
create_policy_definition(
    policy_id="allow-all",
    policy={
        "@context": "http://www.w3.org/ns/odrl.jsonld",
        "@type": "Set",
        "permission": [{
            "action": "use"
        }]
    }
)

# 2. Create an asset
create_asset(
    asset_id="weather-data",
    properties={
        "name": "Weather Dataset",
        "description": "Historical weather data",
        "contentType": "application/json"
    },
    data_address={
        "type": "HttpData",
        "baseUrl": "https://api.weather.com/data"
    }
)

# 3. Create contract definition linking asset to policy
create_contract_definition(
    contract_definition_id="weather-contract",
    access_policy_id="allow-all",
    contract_policy_id="allow-all",
    assets_selector=[{
        "operandLeft": "https://w3id.org/edc/v0.0.1/ns/id",
        "operator": "=",
        "operandRight": "weather-data"
    }]
)
```

## Development

Run the server directly:

```bash
python server.py
```

## Next Steps

Future enhancements could include:
- List/query operations for assets, policies, and contracts
- Update and delete operations
- Contract negotiation tools
- Transfer process initiation and monitoring
