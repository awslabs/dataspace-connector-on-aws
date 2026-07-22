# Deploy Connector Workflow

This steering file guides the agent through deploying and operating Dataspace Connectors on AWS. Follow each phase in order and ask the user for input where indicated.

Deployment is a single GitOps flow: `deploy.sh` creates a CDK Pipeline and a configuration repository, then the pipeline provisions each connector's identity from the Cofinity-X Portal, deploys it, writes its OAuth secret, and registers it for discovery. All stacks are named with a `Deploy-` prefix (`Deploy-DataspaceConnectorSharedInfraStack`, `Deploy-DataspaceConnector-<connectorId>`). See the **cofinity-x-portal** steering file for Portal API background.

---

## Phase 1: Verify Prerequisites

Run all checks in a single command:

```bash
echo "=== Node ===" && node --version && echo "=== CDK ===" && cdk --version && echo "=== Python ===" && python3 --version && echo "=== uv ===" && uv --version && echo "=== git ===" && git --version && echo "=== AWS Identity ===" && aws sts get-caller-identity
```

Node.js 24+, the AWS CDK CLI, Python with `uv` (for the MCP server), Git, and working AWS credentials are required. Java and a container runtime are not needed locally: the EDC build and Docker images are built inside the pipeline's CodeBuild.

Store the AWS profile and the identity ARN. If `$AWS_PROFILE` is unset, ask the user which profile to use, then re-run `aws sts get-caller-identity --profile <profile>` and use that ARN (the IAM principal for the Management API in Phase 3).

---

## Phase 2: Choose Region

Ask the user which AWS region to deploy to (default `eu-central-1`). Store it; it is needed for the deploy script and MCP configuration.

---

## Phase 3: Cofinity-X Portal Setup

These steps are done by the user in the Cofinity-X Portal. See `docs/obtaining-edc-identity-credentials.md` for a screenshot walkthrough.

1. **Admin technical user (once).** Create a technical user with the **Offer Management** and **Dataspace Discovery** roles. The pipeline authenticates as this user to read per-connector credentials and register connectors. `deploy.sh` will prompt for its Client ID and Secret.
2. **Per-connector technical user.** For each connector, create a technical user with the **Identity Wallet Management** role, wait for its status to become `ACTIVE`, and copy its **service account ID** (the `ID` field on the Technical User Details page).
3. **Organization identity values.** From the portal's "Configure Your Connector" dialog, collect the organization-wide values: trusted issuer, OAuth token URL, DIM URL, participant Business Partner Number (BPN), organization Decentralized Identifier (DID), and BPN/DID Resolution Service (BDRS) URL. These are the same for every connector.

---

## Phase 4: Write the Configuration

The pipeline seeds its configuration repository from `cdk/config-templates/` on first deploy, so edit those files before running `deploy.sh`.

### `cdk/config-templates/deployment.yaml`

Set the profile, VPC CIDR, the IAM principal ARN(s) from Phase 1, and the `portal` section with the organization identity values from Phase 3:

```yaml
profile: development
vpcIpAddresses: "10.0.0.0/20"
containerInsights: true
managementApiPrincipals:
  - "<user-provided-arn>"
observabilityApiPrincipals:
  - "<user-provided-arn>"
portal:
  environment: beta          # "beta" or "production"
  identity:
    trustedIssuer: "<did:web:...>"
    stsOauthTokenUrl: "<oauth-token-url>"
    stsDimUrl: "<dim-url>"
    participantId: "<BPNL...>"
    dcpId: "<did:web:...>"
    didResolver: "<bdrs-url>"
```

### `cdk/config-templates/connectors/connector-<id>.yaml`

One file per connector. Reference the per-connector technical user by its service account ID. The pipeline reads that user's credentials and fills in the EDC identity, so no `edcIam` block is authored here.

```yaml
connectorId: <user-chosen-id>
profile: production          # On-Demand; omit to inherit deployment.yaml's profile
controlPlaneCpu: 256
controlPlaneMemoryLimitMiB: 1024
dataPlaneCpu: 256
dataPlaneMemoryLimitMiB: 512
stateMachineIterationMillis: "10000"
edcStateRemovalPolicy: DESTROY
edcTechnicalUserId: "<service-account-id-from-phase-3>"
```

`connectorId` must be 2-60 characters, lowercase alphanumeric and hyphens, and cannot start or end with a hyphen. Replace the example template file (`connector-example.yaml`) with the real connector file(s).

---

## Phase 5: Deploy

Export the profile and region, then run the deploy script from the repository root:

```bash
export AWS_PROFILE=<deployment-profile>
export AWS_REGION=<chosen-region>
./deploy.sh
```

`deploy.sh` installs dependencies, bootstraps the account, deploys `DataspaceConnectorPipelineStack`, seeds the CodeCommit config repository from the templates, then prompts for the admin technical user's Client ID and Secret (stored in Secrets Manager, never in CloudFormation). This is interactive, so the user runs it (the secret prompt cannot be piped safely).

The pipeline then runs automatically:
1. **Synth** reads each connector's client ID from the portal and assembles its EDC identity.
2. **Deploy** creates `Deploy-DataspaceConnectorSharedInfraStack` and a `Deploy-DataspaceConnector-<connectorId>` stack per connector.
3. **PortalFinalization** writes each connector's OAuth secret to Secrets Manager and registers it in the portal.

There is no manual secret step: the pipeline writes the OAuth client secret automatically. Monitor progress with `aws codepipeline get-pipeline-state --name DataspaceConnectorPipeline --region <region>`.

Ongoing changes (adding or removing connectors, upgrading `appVersion`) are made by pushing to the configuration repository, not by editing the templates again.

---

## Phase 6: Configure MCP Access

After the Deploy stage completes, read the Management API URL from the shared-infra stack output and write the MCP config. All values are known, so do not prompt the user.

```bash
aws cloudformation describe-stacks --stack-name Deploy-DataspaceConnectorSharedInfraStack --region <region> \
    --query "Stacks[0].Outputs[?OutputKey=='ManagementApiUrl'].OutputValue" --output text
```

Write or merge the `dataspace-connector-on-aws` entry into `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "dataspace-connector-on-aws": {
      "command": "uv",
      "args": ["--directory", "<absolute-path-to-mcp-directory>", "run", "dataspace-connector-mcp"],
      "env": {
        "EDC_MANAGEMENT_URL": "<ManagementApiUrl-output>",
        "EDC_USE_AWS_IAM": "true",
        "EDC_MULTI_CONNECTOR": "true",
        "AWS_REGION": "<region>",
        "AWS_PROFILE": "<aws-profile>"
      }
    }
  }
}
```

Use the `ManagementApiUrl` value directly (it is the base `.../management/` URL). In multi-connector mode the connector is selected per tool call via `connector_id`, so the URL has no connector suffix. Preserve any other server entries already in the file, and update all env values if a `dataspace-connector-on-aws` entry already exists.

---

## Phase 7: Validate MCP Access

After Kiro picks up the MCP server, verify discovery and one connector:

```python
list_connectors()
query_assets(connector_id="<connectorId>", limit=1)
```

`list_connectors()` returns the deployed connector IDs (it scans CloudFormation for `Deploy-DataspaceConnector-` stacks). If the calls succeed, the connector is deployed and the MCP tools are connected (19 tools available). Then move to the **validate-data-exchange** steering file for an end-to-end data exchange test.

If a call fails, check: AWS credentials are valid, the IAM principal ARN matches `managementApiPrincipals`, `EDC_MANAGEMENT_URL` matches the `ManagementApiUrl` output, `EDC_MULTI_CONNECTOR=true` is set, and the region is correct.
