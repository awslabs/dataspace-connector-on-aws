# Deploy Connector Workflow

This steering file guides the agent through deploying and operating Dataspace Connectors on AWS. Follow each phase in order and ask the user for input where indicated.

Deployment is a single GitOps flow: `deploy.sh` creates a CDK Pipeline and a configuration repository, then the pipeline provisions each connector's identity from the Cofinity-X Portal, deploys it, writes its OAuth secret, and registers it for discovery. Stacks are prefixed by the deployment name (default `DataspaceConnector`): `DataspaceConnector-SharedInfra` for shared infrastructure and `DataspaceConnector-Connector-<connectorId>` per connector. See the **cofinity-x-portal** steering file for Portal API background.

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

This step is done by the user in the Cofinity-X Portal and AWS Secrets Manager. See `docs/cofinity-x-portal-setup.md`.

**Admin technical user (once per organization).** Create an internal technical user with only the **Connector Management** role, and store its Client ID and Secret as `{"clientId":"...","clientSecret":"..."}` in the Secrets Manager secret `DataspaceConnector/portal-admin/<BPNL>` before the first deploy. The pipeline authenticates as this user to create each connector's technical user and register the connector; nothing else is created in the portal by hand.

---

## Phase 4: Write the Configuration

The pipeline seeds its configuration repository from `cdk/config-templates/` on first deploy, so edit those files before running `deploy.sh`.

### `cdk/config-templates/deployment.yaml`

Set the profile, VPC CIDR, the IAM principal ARN(s) from Phase 1, and the `portal` section with the organization's BPNL:

```yaml
profile: development
vpcIpAddresses: "10.0.0.0/20"
containerInsights: true
managementApiPrincipals:
  - "<user-provided-arn>"
observabilityApiPrincipals:
  - "<user-provided-arn>"
portal:
  environment: beta          # only "beta" is supported yet
  bpnl: "<BPNL...>"          # default BPNL of every connector
```

### `cdk/config-templates/connectors/connector-<id>.yaml`

One file per connector. The pipeline creates the connector's technical user and derives its EDC identity, so no identity is authored here. Set `bpnl` only for a connector of a different organization than `portal.bpnl`.

```yaml
connectorId: <user-chosen-id>
profile: production          # On-Demand; omit to inherit deployment.yaml's profile
controlPlaneCpu: 256
controlPlaneMemoryLimitMiB: 1024
dataPlaneCpu: 256
dataPlaneMemoryLimitMiB: 512
interactiveStateMachineIterationMillis: "10000" # negotiation, transfer, data-flow
backgroundStateMachineIterationMillis: "60000"  # policy monitor + data-plane selector
# stateRemovalPolicy: DESTROY  # Optional; default RETAIN keeps the connector's DynamoDB table and S3 bucket on deletion
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

`deploy.sh` installs dependencies, bootstraps the account, deploys `DataspaceConnectorPipelineStack`, and seeds the CodeCommit config repository (`DataspaceConnector-config`) from the templates.

The pipeline then runs automatically:
1. **Synth** builds the EDC images and synthesizes the stacks.
2. **Deploy** creates `DataspaceConnector-SharedInfra` and a `DataspaceConnector-Connector-<connectorId>` stack per connector. Each connector stack creates the connector's technical user in the portal, waits until the portal has provisioned it (several minutes on first deploy), stores its OAuth secret, and registers the connector for discovery.
3. **PortalFinalization** publishes BaSyx DTR offers and deletes the stacks of removed connectors.

Monitor progress with `aws codepipeline get-pipeline-state --name DataspaceConnectorPipeline --region <region>`.

Ongoing changes (adding or removing connectors, upgrading `appVersion`) are made by pushing to the configuration repository, not by editing the templates again.

---

## Phase 6: Configure MCP Access

After the Deploy stage completes, read the Management API URL from the shared-infra stack output and write the MCP config. All values are known, so do not prompt the user.

```bash
aws cloudformation describe-stacks --stack-name DataspaceConnector-SharedInfra --region <region> \
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

Use the `ManagementApiUrl` value directly (it is the base `.../management/` URL). In multi-connector mode the connector is selected per tool call via `connector_id`, so the URL has no connector suffix. If you set a custom `deploymentName`, add `DEPLOYMENT_NAME` with the same value to the `env` so `list_connectors` targets the right stacks (it defaults to `DataspaceConnector`). Preserve any other server entries already in the file, and update all env values if a `dataspace-connector-on-aws` entry already exists.

---

## Phase 7: Validate MCP Access

After Kiro picks up the MCP server, verify discovery and one connector:

```python
list_connectors()
query_resources(connector_id="<connectorId>", resource_type="assets", limit=1)
```

`list_connectors()` returns the deployed connector IDs (it scans CloudFormation for `DataspaceConnector-Connector-` stacks). If the calls succeed, the connector is deployed and the MCP tools are connected (12 tools available). Then move to the **validate-data-exchange** steering file for an end-to-end data exchange test.

If a call fails, check: AWS credentials are valid, the IAM principal ARN matches `managementApiPrincipals`, `EDC_MANAGEMENT_URL` matches the `ManagementApiUrl` output, `EDC_MULTI_CONNECTOR=true` is set, and the region is correct.
