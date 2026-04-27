---
name: "dataspace-connector-on-aws"
displayName: "Dataspace Connector on AWS"
description: "Deploy and interact with a production-ready Catena-X Dataspace Connector on AWS. Guides you from zero to a fully deployed connector with validated end-to-end data exchange within minutes."
keywords: ["dataspace", "connector", "catena-x", "edc", "tractus-x"]
author: "AWS"
---

# Dataspace Connector on AWS

## Overview

This power helps you deploy and operate a production-ready Dataspace Connector for Catena-X on AWS. It combines an AWS CDK deployment blueprint with 15 MCP tools for interacting with the Eclipse Dataspace Components (EDC) Management API.

The connector uses Tractus-X EDC with AWS-native integrations: Amazon DynamoDB for control plane persistence, AWS Secrets Manager for credentials, Amazon S3 for data transfer, and Amazon API Gateway with IAM authorization for secure API access.

With this power, you can go from zero to a fully deployed connector with validated end-to-end data exchange in minutes.

## When to Load Steering Files

- Deploying the connector from scratch → `deploy-connector.md`
- Validating data exchange end-to-end (creating offerings, negotiating, transferring) → `validate-data-exchange.md`
- Researching a Catena-X use case for compliance analysis before prototyping → `prototype-use-case.md`

## Available Steering Files

- **deploy-connector** — Step-by-step guided workflow to configure, deploy, and validate your connector on AWS
- **validate-data-exchange** — End-to-end validation workflow to create data offerings, negotiate contracts, transfer data, and troubleshoot issues
- **prototype-use-case** — Research and compliance analysis workflow for a specific Catena-X use case. Loads KIT documentation, all applicable standards (with recursive normative reference resolution), and semantic data models. Produces a full compliance brief with every MUST/SHOULD/MAY requirement extracted verbatim, JSON schemas, example payloads, and EDC configuration requirements.

## Available MCP Tools

This power provides 18 tools covering the full EDC Management API workflow:

### Provider-side tools (create data offerings)
- `create_asset` — Create a new asset with data address
- `create_policy_definition` — Create a new policy definition with ODRL rules
- `create_contract_definition` — Create a contract definition linking assets to policies

### Consumer-side tools (discover and consume data)
- `request_catalog` — Request the catalog from another connector to discover available datasets
- `initiate_contract_negotiation` — Start a contract negotiation (passes full policy from catalog)
- `get_contract_negotiation` — Get the full contract negotiation object including state, contractAgreementId, and errorDetail
- `get_contract_agreement` — Retrieve a finalized contract agreement
- `initiate_transfer` — Start a data transfer using a contract agreement
- `get_transfer_process` — Get the full transfer process object including state, correlationId, and errorDetail
- `get_edr_data_address` — Get the endpoint data reference (EDR) for an active transfer
- `fetch_data_with_edr` — Fetch actual data from the provider's data plane using an EDR (handles token refresh transparently)
- `initiate_edr_negotiation` — Combined negotiation + transfer in one call (shortcut for the full consumer flow)

### Query tools
- `query_assets` — List/search assets with filtering and pagination
- `query_policy_definitions` — List/search policy definitions
- `query_contract_definitions` — List/search contract definitions
- `query_contract_negotiations` — List/search contract negotiations
- `query_transfer_processes` — List/search transfer processes
- `query_contract_agreements` — List/search contract agreements

## Onboarding

### Prerequisites

Before deploying, ensure the following are installed on your machine:
- `corretto@17` (or any Java 17 JDK)
- `docker` (running)
- `node@24` and `npm`
- `cdk` (AWS CDK CLI)
- `python@3.10+` and `uv` (for the MCP server)
- AWS credentials configured (`aws configure` or SSO)

If any of these are missing, review the project's README for setup instructions.

### Catena-X Membership

Your organization must be onboarded to the Catena-X data space. You will need the following from the Cofinity-X Portal:
- BPNL (Business Partner Number Legal)
- DID (Decentralized Identifier)
- OAuth client ID and token URL
- BDRS server URL
- DIM URL
- Trusted issuer ID

### Getting Started

To deploy your connector, activate the **deploy-connector** steering file which walks you through:
1. Verifying prerequisites
2. Configuring your connector with Catena-X membership details
3. Setting AWS resource configuration (IAM principals, region)
4. Running the deployment
5. Post-deployment setup (OAuth client secret)
6. Configuring and validating MCP access

Once deployed, activate the **validate-data-exchange** steering file to validate the full data exchange flow end-to-end — creating offerings, negotiating contracts, transferring data, and verifying the payload reaches the consumer.

### Add Hooks

Add a hook to `.kiro/hooks/catena-x-compliance-check.kiro.hook` to automatically verify Catena-X compliance when creating EDC resources:

```json
{
  "enabled": true,
  "name": "Catena-X Compliance Check",
  "description": "After creating EDC assets, policies, or contract definitions via MCP tools, verifies that the created resources comply with the Catena-X standards and normative requirements loaded during the prototype-use-case research workflow.",
  "version": "1",
  "when": {
    "type": "postToolUse",
    "toolTypes": [
      ".*create_asset.*",
      ".*create_policy_definition.*",
      ".*create_contract_definition.*"
    ]
  },
  "then": {
    "type": "askAgent",
    "prompt": "A Catena-X EDC resource was just created. If a compliance brief has been loaded in this session (from the prototype-use-case steering file), verify the created resource against the compliance matrix:\n\nFor create_asset: Check that the asset properties include the correct dct:type (cx-taxo:*) and dct:subject values as specified in the applicable standard's DATA ASSET STRUCTURE section. Verify cx-common:version matches. Flag any missing required properties.\n\nFor create_policy_definition: Check that the policy includes the correct UsagePurpose rightOperand value as specified in the standard's USAGE POLICY section. Verify the FrameworkAgreement constraint is present with the correct value. For access policies, verify the appropriate access constraint (e.g., Membership check).\n\nFor create_contract_definition: Verify the access_policy_id and contract_policy_id reference policies that were validated as compliant. Verify the assets_selector targets an asset that was validated as compliant.\n\nIf no compliance brief has been loaded in this session, skip the check silently.\n\nIf a violation is found, state: COMPLIANCE ISSUE: [description]. The standard CX-XXXX requires [requirement]. The created resource [does not meet this / is missing X]. Then suggest the correction."
  }
}
```

This hook fires after `create_asset`, `create_policy_definition`, and `create_contract_definition` MCP tool calls. When a compliance brief has been loaded via the **prototype-use-case** steering file, it checks that the created resource matches the normative requirements. When no brief is loaded, it silently skips.

## Tool Usage Examples

### Discover datasets from another connector
```python
request_catalog(
    counter_party_address="https://provider.example.com/protocol",
    counter_party_id="BPNL000000000001"
)
```

### Full consumer flow: negotiate, transfer, get data
```python
# 1. Negotiate a contract (pass full policy from catalog offer)
initiate_contract_negotiation(
    counter_party_address="https://provider.example.com/protocol",
    offer_id="<offer-id-from-catalog>",
    asset_id="<asset-id>",
    assigner="BPNL000000000001",
    permission=[{"odrl:action": {"@id": "odrl:use"}}],
    prohibition=[],
    obligation=[]
)

# 2. Poll until FINALIZED — returns full object with contractAgreementId
get_contract_negotiation(negotiation_id="<negotiation-id>")

# 3. Extract contractAgreementId from the response above, then retrieve agreement
get_contract_agreement(agreement_id="<agreement-id>")

# 4. Start transfer
initiate_transfer(
    counter_party_address="https://provider.example.com/protocol",
    contract_id="<agreement-id>",
    transfer_type="HttpData-PULL"
)

# 5. Poll until STARTED, then get EDR
get_edr_data_address(transfer_process_id="<transfer-id>")

# 6. Fetch the actual data from the provider's data plane
fetch_data_with_edr(transfer_process_id="<transfer-id>")

# Fetch with sub-path and query params
fetch_data_with_edr(
    transfer_process_id="<transfer-id>",
    path="/items",
    query_params={"limit": "10"}
)
```

### Alternative: Combined negotiation + transfer (shortcut)
```python
# Single call that handles negotiation and transfer automatically
initiate_edr_negotiation(
    counter_party_address="https://provider.example.com/protocol",
    offer_id="<offer-id-from-catalog>",
    asset_id="<asset-id>",
    assigner="BPNL000000000001",
    permission=[{"odrl:action": {"@id": "odrl:use"}}],
    prohibition=[],
    obligation=[]
)

# Poll negotiation until FINALIZED to get the contractAgreementId
negotiation = get_contract_negotiation(negotiation_id="<negotiation-id>")

# Find the transfer process created by the EDR negotiation
transfers = query_transfer_processes(filter_expression=[{
    "operandLeft": "contractId",
    "operator": "=",
    "operandRight": "<contractAgreementId-from-negotiation>"
}])

# Once the transfer reaches STARTED, get the EDR
get_edr_data_address(transfer_process_id="<transfer-id-from-query>")

# Fetch the actual data
fetch_data_with_edr(transfer_process_id="<transfer-id-from-query>")
```

### Create a data offering (provider side)
```python
# 1. Access policy (controls catalog visibility)
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

# 2. Usage policy (controls contract negotiation — requires FrameworkAgreement + UsagePurpose)
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

# 3. Asset
create_asset(
    asset_id="my-dataset",
    properties={"name": "Sample Dataset", "contentType": "application/json"},
    data_address={"type": "HttpData", "baseUrl": "https://example.com/api/data"}
)

# 4. Contract definition (links asset to both policies)
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

## Troubleshooting

### MCP tools return 403 Forbidden
Your AWS credentials don't have `execute-api:Invoke` permission for the Management API Gateway, or your IAM principal ARN isn't listed in `managementApiPrincipals` in `environments.ts`.

### MCP tools return 401 Unauthorized
The `EDC_API_KEY` environment variable in your MCP config doesn't match the `managementApiAuthKey` in `environments.ts`.

### Contract negotiation returns "Policy not equal to offer"
You must pass the full policy from the catalog offer (including `permission`, `prohibition`, `obligation` arrays) when calling `initiate_contract_negotiation`. Don't construct a minimal policy stub.

### Transfer stuck in INITIAL state
Ensure `dataDestination` is provided. For `HttpData-PULL` transfers, the MCP server automatically sets `{"type": "HttpProxy"}` as the destination.

### Credentials expire during long sessions
The MCP server refreshes AWS credentials on every request, so temporary credentials (SSO, IAM roles) work without restarting the server.

## Configuration Reference

### environments.ts — EDC IAM Settings (from Cofinity-X Portal)

| Field | Description |
|-------|-------------|
| `DID_RESOLVER` | BDRS server URL for DID resolution |
| `DIM_URL` | DIM integration service URL |
| `IATP_ID` | Your organization's DID |
| `OAUTH_CLIENT_ID` | Technical user OAuth client ID |
| `OAUTH_TOKEN_URL` | OAuth token endpoint URL |
| `PARTICIPANT_ID` | Your organization's DID (same as `IATP_ID`) |
| `PARTICIPANT_BPN` | Your BPNL number |
| `TRUSTED_ISSUER_ID` | Trusted issuer DID (Cofinity-X) |

### environments.ts — AWS Resource Settings

| Field | Default | Description |
|-------|---------|-------------|
| `controlPlaneCpu` | 256 | Control plane Fargate CPU units |
| `controlPlaneMemoryLimitMiB` | 1024 | Control plane memory (MB) |
| `dataPlaneCpu` | 256 | Data plane Fargate CPU units |
| `dataPlaneMemoryLimitMiB` | 512 | Data plane memory (MB) |
| `managementApiAuthKey` | `""` | EDC API key for x-api-key header |
| `managementApiPrincipals` | `[]` | IAM ARNs allowed to call Management API |
| `observabilityApiPrincipals` | `[]` | IAM ARNs allowed to call Observability API |
| `vpcIpAddresses` | `10.0.10.0/24` | VPC CIDR block |
| `edcStateRemovalPolicy` | `DESTROY` | DynamoDB table removal policy |

---

**MCP Server:** `dataspace-connector-mcp`

## MCP Config Placeholders

Before using this power, replace the following placeholders in `mcp.json` with your actual values:

- **`PLACEHOLDER_MCP_DIRECTORY`**: Absolute path to the `mcp/` subdirectory of this project.
  - **How to get it:** After cloning the repository, use the full path to the `mcp/` folder, e.g., `/Users/yourname/Code/dataspace-connector-on-aws/mcp`

- **`PLACEHOLDER_MANAGEMENT_API_URL`**: The EDC Management API endpoint URL from your CDK deployment output.
  - **How to get it:** After running `deploy.sh`, look for the CDK output key starting with `EdcApiManagementApiEndpoint`. It looks like `https://<api-id>.execute-api.<region>.amazonaws.com/management/`

- **`PLACEHOLDER_API_KEY`**: The EDC API key configured in `managementApiAuthKey` in `environments.ts`.
  - **How to set it:** If you left `managementApiAuthKey` as an empty string during deployment, use an empty string here too. Otherwise, use the value you configured.

- **`PLACEHOLDER_AWS_REGION`**: The AWS region where the connector is deployed.
  - **How to set it:** Use the region you chose during deployment (e.g., `eu-central-1`)

- **`PLACEHOLDER_AWS_PROFILE`**: The AWS CLI profile used for deployment.
  - **How to get it:** Run `echo $AWS_PROFILE` or `aws configure list-profiles` to see available profiles

Note: The **deploy-connector** steering file automates this configuration — it collects all values during deployment and writes the MCP config automatically.
