---
name: "dataspace-connector-on-aws"
displayName: "Dataspace Connector on AWS"
description: "Deploy and interact with a production-ready Catena-X Dataspace Connector on AWS. Guides you from zero to a fully deployed connector with validated end-to-end data exchange within minutes."
keywords: ["dataspace", "connector", "catena-x", "edc", "tractus-x"]
author: "AWS"
---

# Dataspace Connector on AWS

## Overview

This power helps you deploy and operate a production-ready Dataspace Connector for Catena-X on AWS. It combines an AWS CDK deployment blueprint with 12 MCP tools for the Eclipse Dataspace Components (EDC) Management API; each tool's description carries its usage rules.

The connector uses Tractus-X EDC with AWS-native integrations: Amazon DynamoDB for control plane persistence, AWS Secrets Manager for credentials, Amazon S3 for data transfer, and Amazon API Gateway with IAM authorization for secure API access.

Deployment is a single GitOps flow: `deploy.sh` creates a CDK Pipeline and a configuration repository, then the pipeline creates each connector's technical user in the Cofinity-X Portal, deploys the connector, and registers it for discovery. The same configuration repository can hold one or many connectors.

## When to Load Steering Files

- Deploying the connector from scratch → `deploy-connector.md`
- Validating data exchange end-to-end (creating offerings, negotiating, transferring) → `validate-data-exchange.md`
- Researching a Catena-X use case for compliance analysis before prototyping → `prototype-use-case.md`: loads the KIT, all applicable standards and semantic models, and writes a compliance brief

## Onboarding

### Prerequisites

- `node@24` and `npm`
- `aws` (AWS CLI) with credentials configured
- `python@3.10+` and `uv` (for the MCP server)
- `git`
- An organization onboarded to Catena-X, with access to the Cofinity-X Portal

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

## Troubleshooting

### MCP tools return 403 Forbidden
Your AWS credentials don't have `execute-api:Invoke` permission for the Management API Gateway, or your IAM principal ARN isn't listed in `managementApiPrincipals` in `deployment.yaml`.

### Contract negotiation returns "Policy not equal to offer"
You must pass the full policy from the catalog offer (including `permission`, `prohibition`, `obligation`) when calling `initiate_negotiation`. Don't construct a minimal policy stub.

## MCP Config Placeholders

Before using this power, replace the following placeholders in `mcp.json` with your actual values:

- **`PLACEHOLDER_MCP_DIRECTORY`**: Absolute path to the `mcp/` subdirectory of this project.
  - **How to get it:** After cloning the repository, use the full path to the `mcp/` folder, e.g., `/Users/yourname/Code/dataspace-connector-on-aws/mcp`

- **`PLACEHOLDER_AWS_REGION`**: The AWS region where the connector is deployed.
  - **How to set it:** Use the region you chose during deployment (e.g., `eu-central-1`)

- **`PLACEHOLDER_AWS_PROFILE`**: The AWS CLI profile used for deployment.
  - **How to get it:** Run `echo $AWS_PROFILE` or `aws configure list-profiles` to see available profiles

`"EDC_MULTI_CONNECTOR": "true"` makes the server discover the connectors and their API URLs from CloudFormation; every tool call then takes a `connector_id`. With a custom `deploymentName`, add `"DEPLOYMENT_NAME"`.

Note: The **deploy-connector** steering file automates this configuration, it collects all values during deployment and writes the MCP config automatically.
