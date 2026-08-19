# Dataspace Connector on AWS - MCP Server

A Model Context Protocol (MCP) server for interacting with the Eclipse Dataspace Components (EDC) Management API.

## Features

This MCP server provides 12 general-purpose EDC primitives that map closely to the EDC Management API. Workflow orchestration (the consumer and provider sequences) lives in the consuming skill/agent, keeping the server workflow-agnostic, so new dataspace use cases need no new server tools.

### Discovery
- **list_connectors** - Discover deployed connector IDs and the Management/DSP base URLs from CloudFormation (requires `EDC_MULTI_CONNECTOR=true`). Call this first in multi-connector mode.

### Generic resource operations
- **query_resources** - List/query a resource collection by `resource_type`: `assets`, `policy_definitions`, `contract_definitions`, `contract_negotiations`, `contract_agreements`, `transfer_processes`. Optional filter/sort/pagination.
- **get_resource** - Read one resource by id for the same types, plus `edr` (the raw endpoint data reference for a transfer, for inspection). Its description carries the negotiation and transfer state-machine progressions for polling.
- **delete_resource** - Delete a deletable resource (`assets`, `policy_definitions`, `contract_definitions`). Negotiations/agreements are immutable; end a transfer via `manage_transfer`.

### Provider
- **create_asset** - Register a data asset (descriptor + data address).
- **create_policy** - Create an ODRL policy definition (access or usage).
- **create_contract_definition** - Link assets to access + contract policies, making them catalog-visible.

### Consumer
- **request_catalog** - Request a provider's DCAT catalog over DSP.
- **initiate_negotiation** - Start a contract negotiation for a catalog offer (pass the offer's permission/prohibition/obligation through exactly).
- **initiate_transfer** - Start a data transfer against a finalized agreement.
- **manage_transfer** - Suspend / resume / complete / terminate a transfer. Pass `transfer_process_id="all_started"` to apply the action to every STARTED transfer (reaps idle provider-side pull transfers, which keep consuming DynamoDB on this AWS deployment).
- **fetch_data** - Resolve the EDR and fetch the payload from the data plane public API (appends `public/` by default; refreshes the token transparently).

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

# Optional: EDC API key authentication (for standard EDC deployments)
export EDC_API_KEY="your-api-key"

# Optional: Enable AWS IAM authentication for API Gateway (for Dataspace Connector on AWS deployments)
export EDC_USE_AWS_IAM="true"
export AWS_REGION="us-east-1"

# Optional: Enable multi-connector mode (for Dataspace Connector on AWS deployments with multiple EDCs)
export EDC_MULTI_CONNECTOR="true"
```

### Multi-Connector Mode

When `EDC_MULTI_CONNECTOR=true` is set, the MCP server enables dynamic connector discovery:

- A `list_connectors` tool becomes available that queries AWS CloudFormation for the deployed connector stacks and the shared-infrastructure stack outputs
- Discovery targets stacks prefixed by `DEPLOYMENT_NAME` (default `DataspaceConnector`); set it to match a custom `deploymentName` so the server addresses the right deployment when several share an account and region
- It returns the connector IDs plus the Management and DSP (protocol) base URLs (`management_base_url`, `dsp_base_url`); `dsp_base_url` is `null` if unavailable
- All other tools require a `connector_id` parameter (discovered via `list_connectors`)
- Per-connector addresses are built as `{management_base_url}/{connector_id}` and `{dsp_base_url}/{connector_id}` (the latter is the `counter_party_address` for catalog requests and negotiations)
- `EDC_MANAGEMENT_URL` is optional in this mode: when unset it is discovered from the stack's `ManagementApiUrl` output, and when set it overrides discovery (for example, a custom domain)

This mode requires additional IAM permissions beyond `execute-api:Invoke`:
- `cloudformation:ListStacks`: to discover deployed connector IDs
- `cloudformation:DescribeStacks`: to read the Management and DSP endpoint outputs

The MCP server instructions automatically guide agents to call `list_connectors` first when multi-connector mode is active.

When `EDC_MULTI_CONNECTOR` is not set (default), the server operates in legacy single-connector mode where all tools target `EDC_MANAGEMENT_URL` directly, compatible with any EDC installation.

### Authentication Modes

The MCP server supports two authentication modes that can be used independently or combined:

1. **EDC API Key** (`EDC_API_KEY`) — Sends an `X-Api-Key` header with each request. Used by standard EDC deployments that enable token-based authentication. Only included when the value is non-empty.

2. **AWS SigV4** (`EDC_USE_AWS_IAM=true`) — Signs all requests with AWS SigV4 for API Gateway IAM authorization. Used when the EDC Management API is deployed behind Amazon API Gateway (as in this project).

For this project's deployment, only SigV4 is needed (`EDC_USE_AWS_IAM=true`, no `EDC_API_KEY`). For other EDC deployments, set `EDC_API_KEY` and leave `EDC_USE_AWS_IAM` unset.

The server uses boto3's standard credential chain:
- Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- AWS credentials file (`~/.aws/credentials`)
- AWS SSO credentials
- IAM role (if running on EC2/ECS/Lambda)

Credentials are refreshed automatically on each request, so temporary credentials (IAM roles, SSO) work without restarting the server.

Make sure your AWS credentials have `execute-api:Invoke` permission for the API Gateway.

## Usage with Kiro

### Standard EDC Deployment (API Key auth)

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
        "EDC_MANAGEMENT_URL": "http://your-edc-host:8182/management",
        "EDC_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Dataspace Connector on AWS Deployment (API Gateway with IAM auth)

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
        "EDC_USE_AWS_IAM": "true",
        "AWS_REGION": "us-east-1",
        "AWS_PROFILE": ""
      }
    }
  }
}
```

### Dataspace Connector on AWS — Multi-Connector Mode

For deployments with multiple EDC connectors (e.g., via CDK Pipelines GitOps):

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
        "EDC_USE_AWS_IAM": "true",
        "EDC_MULTI_CONNECTOR": "true",
        "AWS_REGION": "eu-central-1",
        "AWS_PROFILE": ""
      }
    }
  }
}
```

In multi-connector mode, the agent calls `list_connectors` first to discover available connector IDs and the Management/DSP endpoints, then passes `connector_id` to all subsequent tool calls. `EDC_MANAGEMENT_URL` is optional here (discovered from CloudFormation; set it only to override). Set `DEPLOYMENT_NAME` in `env` if your deployment uses a custom `deploymentName` (it defaults to `DataspaceConnector`). The additional IAM permissions required are `cloudformation:ListStacks` and `cloudformation:DescribeStacks`.

## Example Usage

### End-to-end consumer flow

```python
# 0. (multi-connector) discover connectors + endpoints
info = list_connectors()
cid = "carbonex"
provider_dsp = f"{info['dsp_base_url']}/provider-connector"

# 1. Discover available datasets from a provider
catalog = request_catalog(
    connector_id=cid,
    counter_party_address=provider_dsp,
    counter_party_id="BPNL000000000001",
)

# 2. Extract the offer and negotiate.
# permission/prohibition/obligation MUST be passed through exactly from the offer,
# or the provider rejects the negotiation with "Policy not equal to offer".
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

# 3. Poll until FINALIZED, then read the agreement id
neg = get_resource(connector_id=cid, resource_type="contract_negotiations", resource_id=negotiation["@id"])
agreement_id = neg["contractAgreementId"]

# 4. Transfer, then poll until STARTED
transfer = initiate_transfer(
    connector_id=cid,
    counter_party_address=provider_dsp,
    contract_id=agreement_id,
    transfer_type="HttpData-PULL",
)
tp = get_resource(connector_id=cid, resource_type="transfer_processes", resource_id=transfer["@id"])

# 5. Fetch the payload (the /public/ sub-path is appended automatically)
data = fetch_data(connector_id=cid, transfer_process_id=transfer["@id"])

# (optional) inspect the raw EDR instead of fetching
edr = get_resource(connector_id=cid, resource_type="edr", resource_id=transfer["@id"])
```

### Create a data offering (provider side)

```python
# 1. Access policy (controls catalog visibility)
create_policy(
    connector_id=cid,
    policy_id="my-access-policy",
    policy={
        "@type": "Set",
        "permission": [{
            "action": "access",
            "constraint": {"leftOperand": "Membership", "operator": "eq", "rightOperand": "active"},
        }],
    },
)

# 2. Usage policy (controls negotiation)
create_policy(
    connector_id=cid,
    policy_id="my-usage-policy",
    policy={
        "@type": "Set",
        "permission": [{
            "action": "use",
            "constraint": [{"and": [
                {"leftOperand": "FrameworkAgreement", "operator": "eq", "rightOperand": "DataExchangeGovernance:1.0"},
                {"leftOperand": "UsagePurpose", "operator": "isAnyOf", "rightOperand": "cx.core.industrycore:1"},
            ]}],
        }],
    },
)

# 3. Asset (S3 data source)
create_asset(
    connector_id=cid,
    asset_id="my-dataset",
    properties={"name": "Sample Dataset", "contentType": "application/json"},
    data_address={"type": "AmazonS3", "region": "eu-central-1", "bucketName": "my-bucket", "objectName": "path/to/object.json"},
)

# 4. Contract definition (links asset to both policies)
create_contract_definition(
    connector_id=cid,
    contract_definition_id="my-contract-def",
    access_policy_id="my-access-policy",
    contract_policy_id="my-usage-policy",
    assets_selector=[{"operandLeft": "https://w3id.org/edc/v0.0.1/ns/id", "operator": "=", "operandRight": "my-dataset"}],
)
```

### Query, manage, and clean up

```python
# List a resource collection
query_resources(connector_id=cid, resource_type="assets", limit=10)

# Find STARTED transfers
query_resources(connector_id=cid, resource_type="transfer_processes", filter_expression=[{
    "operandLeft": "state", "operator": "=", "operandRight": "STARTED",
}])

# Terminate one transfer, or reap ALL started transfers (provider-side DynamoDB cost cleanup)
manage_transfer(connector_id=cid, transfer_process_id="<transfer-id>", action="terminate", reason="done")
manage_transfer(connector_id=cid, transfer_process_id="all_started", action="terminate", reason="idle cleanup")

# Delete a test asset / policy / contract definition
delete_resource(connector_id=cid, resource_type="contract_definitions", resource_id="my-contract-def")
```

## Development

Run the server directly:

```bash
python server.py
```
