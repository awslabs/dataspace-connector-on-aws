---
name: "dataspace-connector-on-aws"
displayName: "Dataspace Connector on AWS"
description: "Deploy and interact with a production-ready Catena-X Dataspace Connector on AWS. Guides you from zero to a fully deployed connector with validated end-to-end data exchange within minutes."
keywords: ["dataspace", "connector", "catena-x", "edc", "tractus-x"]
author: "AWS"
---

# Dataspace Connector on AWS

## Overview

This power helps you deploy and operate a production-ready Dataspace Connector for Catena-X on AWS. It combines an AWS CDK deployment blueprint with 12 MCP tools for interacting with the Eclipse Dataspace Components (EDC) Management API.

The connector uses Tractus-X EDC with AWS-native integrations: Amazon DynamoDB for control plane persistence, AWS Secrets Manager for credentials, Amazon S3 for data transfer, and Amazon API Gateway with IAM authorization for secure API access.

Deployment is a single GitOps flow: `deploy.sh` creates a CDK Pipeline and a configuration repository, then the pipeline provisions each connector's identity from the Cofinity-X Portal, deploys it, and registers it for discovery. The same configuration repository can hold one or many connectors.

With this power, you can go from zero to a fully deployed connector with validated end-to-end data exchange in minutes.

## When to Load Steering Files

- Deploying the connector from scratch → `deploy-connector.md`
- Validating data exchange end-to-end (creating offerings, negotiating, transferring) → `validate-data-exchange.md`
- Researching a Catena-X use case for compliance analysis before prototyping → `prototype-use-case.md`

## Available Steering Files

- **deploy-connector**: Step-by-step guided workflow to configure, deploy, and validate your connector(s) on AWS via the deployment pipeline and Cofinity-X Portal integration
- **validate-data-exchange**: End-to-end validation workflow to create data offerings, negotiate contracts, transfer data, and troubleshoot issues
- **prototype-use-case**: Research and compliance analysis workflow for a specific Catena-X use case. Loads KIT documentation, all applicable standards (with recursive normative reference resolution), and semantic data models. Produces a full compliance brief with every MUST/SHOULD/MAY requirement extracted verbatim, JSON schemas, example payloads, and EDC configuration requirements.
- **cofinity-x-portal**: Reference for Catena-X and Cofinity-X Portal concepts and the Portal API used during deployment: obtaining identity credentials, technical users, and connector registration

## Available MCP Tools

This power provides 12 general-purpose EDC primitives. Workflow orchestration (the consumer and provider sequences) lives in the steering files and the agent, keeping the server workflow-agnostic.

### Discovery (multi-connector deployments)
- `list_connectors`: Discover all deployed connector IDs and the Management/DSP base URLs from CloudFormation (requires `EDC_MULTI_CONNECTOR=true`)

### Generic resource operations
- `query_resources`: List/query a resource collection by `resource_type` (`assets`, `policy_definitions`, `contract_definitions`, `contract_negotiations`, `contract_agreements`, `transfer_processes`), with optional filter/sort/pagination
- `get_resource`: Read one resource by id for the same types, plus `edr` (the raw endpoint data reference for a transfer, for inspection). Carries the negotiation and transfer state-machine progressions for polling
- `delete_resource`: Delete a deletable resource (`assets`, `policy_definitions`, `contract_definitions`)

### Provider-side tools (create data offerings)
- `create_asset`: Create a new asset with data address
- `create_policy`: Create a new policy definition with ODRL rules
- `create_contract_definition`: Create a contract definition linking assets to policies

### Consumer-side tools (discover and consume data)
- `request_catalog`: Request the catalog from another connector to discover available datasets
- `initiate_negotiation`: Start a contract negotiation (pass the catalog offer's policy through exactly)
- `initiate_transfer`: Start a data transfer using a contract agreement
- `manage_transfer`: Suspend / resume / complete / terminate a transfer; pass `transfer_process_id="all_started"` to terminate every STARTED transfer (idle provider-side pull transfers accrue DynamoDB cost)
- `fetch_data`: Fetch data from the provider's data plane for an active transfer, resolving the EDR and appending the `public/` sub-path automatically (handles token refresh transparently)

## Onboarding

### Prerequisites

Before deploying, ensure the following are installed on your machine:
- `node@24` and `npm`
- `cdk` (AWS CDK CLI)
- `aws` (AWS CLI) with credentials configured (`aws configure` or SSO)
- `python@3.10+` and `uv` (for the MCP server)
- `git`

Java and a container runtime are not needed locally: the EDC build and Docker images are built inside the pipeline's CodeBuild. If any of the above are missing, review the project's README for setup instructions.

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
2. Setting up the required Cofinity-X Portal technical users
3. Configuring your connector(s) with Catena-X membership details
4. Setting AWS resource configuration (IAM principals, region)
5. Running the deployment (`deploy.sh`)
6. Configuring and validating MCP access

Once deployed, activate the **validate-data-exchange** steering file to validate the full data exchange flow end-to-end, creating offerings, negotiating contracts, transferring data, and verifying the payload reaches the consumer.

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
      ".*create_policy.*",
      ".*create_contract_definition.*"
    ]
  },
  "then": {
    "type": "askAgent",
    "prompt": "A Catena-X EDC resource was just created. If a compliance brief has been loaded in this session (from the prototype-use-case steering file), verify the created resource against the compliance matrix:\n\nFor create_asset: Check that the asset properties include the correct dct:type (cx-taxo:*) and dct:subject values as specified in the applicable standard's DATA ASSET STRUCTURE section. Verify cx-common:version matches. Flag any missing required properties.\n\nFor create_policy: Check that the policy includes the correct UsagePurpose rightOperand value as specified in the standard's USAGE POLICY section. Verify the FrameworkAgreement constraint is present with the correct value. For access policies, verify the appropriate access constraint (e.g., Membership check).\n\nFor create_contract_definition: Verify the access_policy_id and contract_policy_id reference policies that were validated as compliant. Verify the assets_selector targets an asset that was validated as compliant.\n\nIf no compliance brief has been loaded in this session, skip the check silently.\n\nIf a violation is found, state: COMPLIANCE ISSUE: [description]. The standard CX-XXXX requires [requirement]. The created resource [does not meet this / is missing X]. Then suggest the correction."
  }
}
```

This hook fires after `create_asset`, `create_policy`, and `create_contract_definition` MCP tool calls. When a compliance brief has been loaded via the **prototype-use-case** steering file, it checks that the created resource matches the normative requirements. When no brief is loaded, it silently skips.

## Tool Usage Examples

### Discover connectors and datasets
```python
# Discover deployed connectors + Management/DSP base URLs (multi-connector mode)
list_connectors()

# Browse another connector's catalog
request_catalog(
    connector_id="<your-connector>",
    counter_party_address="https://provider.example.com/protocol/<provider-connector>",
    counter_party_id="BPNL000000000001"
)
```

### Full consumer flow: negotiate, transfer, get data
```python
# 1. Negotiate a contract (pass the catalog offer's policy through exactly)
initiate_negotiation(
    connector_id="<your-connector>",
    counter_party_address="https://provider.example.com/protocol/<provider-connector>",
    offer_id="<offer-id-from-catalog>",
    asset_id="<asset-id>",
    assigner="BPNL000000000001",
    permission=<odrl:permission from catalog offer>,
    prohibition=<odrl:prohibition from catalog offer>,
    obligation=<odrl:obligation from catalog offer>
)

# 2. Poll until FINALIZED: the response carries contractAgreementId
get_resource(connector_id="<your-connector>", resource_type="contract_negotiations", resource_id="<negotiation-id>")

# 3. (optional) retrieve the agreement itself
get_resource(connector_id="<your-connector>", resource_type="contract_agreements", resource_id="<agreement-id>")

# 4. Start transfer
initiate_transfer(
    connector_id="<your-connector>",
    counter_party_address="https://provider.example.com/protocol/<provider-connector>",
    contract_id="<agreement-id>",
    transfer_type="HttpData-PULL"
)

# 5. Poll until STARTED
get_resource(connector_id="<your-connector>", resource_type="transfer_processes", resource_id="<transfer-id>")

# 6. Fetch the data (appends the /public/ sub-path automatically)
fetch_data(connector_id="<your-connector>", transfer_process_id="<transfer-id>")

# Fetch with a sub-path and query params
fetch_data(
    connector_id="<your-connector>",
    transfer_process_id="<transfer-id>",
    path="/public/items",
    query_params={"limit": "10"}
)

# Inspect the raw EDR (endpoint, token, refresh info) without fetching
get_resource(connector_id="<your-connector>", resource_type="edr", resource_id="<transfer-id>")
```

### List, terminate, and clean up
```python
# List a resource collection. NOTE: filter the `state` field by EDC's integer
# state code as a number (600=STARTED, 850=TERMINATED), not the string label.
query_resources(connector_id="<your-connector>", resource_type="transfer_processes", limit=50)

# End one transfer, or every STARTED transfer at once. Idle provider-side pull
# transfers keep a data-plane flow active and accrue DynamoDB cost.
manage_transfer(connector_id="<your-connector>", transfer_process_id="<transfer-id>", action="terminate", reason="done")
manage_transfer(connector_id="<your-connector>", transfer_process_id="all_started", action="terminate", reason="idle cleanup")

# Delete a test asset / policy / contract definition. Delete the contract definition
# first; an asset referenced by a finalized agreement returns 409 until it is gone.
delete_resource(connector_id="<your-connector>", resource_type="contract_definitions", resource_id="my-contract-def")
```

### Create a data offering (provider side)
```python
# 1. Access policy (controls catalog visibility)
create_policy(
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

# 2. Usage policy (controls contract negotiation: requires FrameworkAgreement + UsagePurpose)
create_policy(
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
Your AWS credentials don't have `execute-api:Invoke` permission for the Management API Gateway, or your IAM principal ARN isn't listed in `managementApiPrincipals` in `deployment.yaml`.

### Contract negotiation returns "Policy not equal to offer"
You must pass the full policy from the catalog offer (including `permission`, `prohibition`, `obligation`) when calling `initiate_negotiation`. Don't construct a minimal policy stub.

### Transfer stuck in INITIAL state
Ensure `dataDestination` is provided. For `HttpData-PULL` transfers, the MCP server automatically sets `{"type": "HttpProxy"}` as the destination.

### Credentials expire during long sessions
The MCP server refreshes AWS credentials on every request, so temporary credentials (SSO, IAM roles) work without restarting the server.

## Configuration Reference

### EDC Identity Settings (from Cofinity-X Portal)

These values are the deployment-wide default, configured once in the `portal.identity` section of `deployment.yaml`; a connector may override any of them under its own `portal.identity` to host multiple organizations (BPNLs) in one deployment. The pipeline reads each connector's technical-user credentials from the portal (referenced by `serviceAccountId` in the connector YAML) and assembles the rest of the EDC identity automatically.

| YAML Field (`portal.identity`) | EDC Property | Description |
|------|------|-------------|
| `trustedIssuer` | `edc.iam.trusted-issuer.issuer-1.id` | Trusted issuer DID (Cofinity-X) |
| `stsOauthTokenUrl` | `edc.iam.sts.oauth.token.url` | OAuth token endpoint URL |
| `stsDimUrl` | `tx.edc.iam.sts.dim.url` | DIM integration service URL |
| `participantId` | `tractusx.edc.participant.bpn` | Your organization's BPN |
| `dcpId` | `edc.iam.issuer.id` | Your organization's Decentralized Identifier (DID) |
| `didResolver` | `tx.edc.iam.iatp.bdrs.server.url` | BDRS server URL for DID resolution |

### AWS Resource Settings

Split between `deployment.yaml` (shared infrastructure) and `connector-<id>.yaml` (per-connector):

| Field | Default | Description |
|-------|---------|-------------|
| `controlPlaneCpu` | 256 | Control plane Fargate CPU units |
| `controlPlaneMemoryLimitMiB` | 1024 | Control plane memory (MB) |
| `dataPlaneCpu` | 256 | Data plane Fargate CPU units |
| `dataPlaneMemoryLimitMiB` | 512 | Data plane memory (MB) |
| `managementApiPrincipals` | `[]` | IAM ARNs allowed to call Management API |
| `observabilityApiPrincipals` | `[]` | IAM ARNs allowed to call Observability API |
| `vpcIpAddresses` | `10.0.0.0/20` | VPC CIDR block |
| `edcStateRemovalPolicy` | `DESTROY` | DynamoDB table removal policy |

---

**MCP Server:** `dataspace-connector-mcp`

## MCP Config Placeholders

Before using this power, replace the following placeholders in `mcp.json` with your actual values:

- **`PLACEHOLDER_MCP_DIRECTORY`**: Absolute path to the `mcp/` subdirectory of this project.
  - **How to get it:** After cloning the repository, use the full path to the `mcp/` folder, e.g., `/Users/yourname/Code/dataspace-connector-on-aws/mcp`

- **`PLACEHOLDER_MANAGEMENT_API_URL`**: The EDC Management API endpoint URL from your deployment.
  - **How to get it:** After the pipeline's Deploy stage completes, read the `ManagementApiUrl` output of the `DataspaceConnector-SharedInfra`. It looks like `https://<api-id>.execute-api.<region>.amazonaws.com/management/`. Use it as-is (the base URL without a connector suffix); the `connector_id` parameter on each tool call handles routing.

- **`PLACEHOLDER_AWS_REGION`**: The AWS region where the connector is deployed.
  - **How to set it:** Use the region you chose during deployment (e.g., `eu-central-1`)

- **`PLACEHOLDER_AWS_PROFILE`**: The AWS CLI profile used for deployment.
  - **How to get it:** Run `echo $AWS_PROFILE` or `aws configure list-profiles` to see available profiles

The `mcp.json` template sets `"EDC_MULTI_CONNECTOR": "true"`, which enables `list_connectors()` discovery and requires `connector_id` on all tool calls. Keep this enabled for pipeline deployments.

Note: The **deploy-connector** steering file automates this configuration, it collects all values during deployment and writes the MCP config automatically.
