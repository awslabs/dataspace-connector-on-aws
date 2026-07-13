# Deploy Connector Workflow

This steering file guides the agent through deploying a Dataspace Connector on AWS from scratch. Follow each phase in order. Ask the user for input where indicated.

The project supports two deployment modes:
- **Local deploy** (`deploy-local.sh`) — Direct `cdk deploy`, ideal for getting started with a single connector. Stacks are named `DataspaceConnectorSharedInfraStack` and `DataspaceConnector-<connectorId>`.
- **Pipeline deploy** (`deploy-pipeline.sh`) — CI/CD via CodePipeline with a config repository (CodeCommit or GitHub), ideal for production with multiple connectors. Stacks are named with a `Deploy-` prefix: `Deploy-DataspaceConnectorSharedInfraStack` and `Deploy-DataspaceConnector-<connectorId>`.

Ask the user early (Phase 2) which mode they prefer. The choice affects configuration (Phase 3-4), deployment (Phase 5), and MCP setup (Phase 7).

---

## Phase 1: Verify Prerequisites

Before starting, check that the user's machine is ready.

IMPORTANT: Run ALL checks in a SINGLE bash command to avoid opening multiple terminals. Use this exact command:

```bash
echo "=== Java ===" && java -version 2>&1 && echo "=== Container Runtime ===" && (docker info 2>/dev/null || finch info 2>/dev/null || echo "MISSING: docker or finch") && echo "=== Node ===" && node --version && echo "=== npm ===" && npm --version && echo "=== CDK ===" && cdk --version && echo "=== Python ===" && python3 --version && echo "=== uv ===" && uv --version && echo "=== AWS Identity ===" && aws sts get-caller-identity
```

If the container runtime is Finch (not Docker), perform these additional checks:

1. Check whether `CDK_DOCKER` is already set:

```bash
echo $CDK_DOCKER
```

- If it's already set and contains `finch` (e.g., `finch` or `/path/to/finch`), no action needed.
- If it's empty, uncomment `export CDK_DOCKER=finch` in `deploy-local.sh`.

2. Check whether the Finch VM is running:

```bash
finch vm status
```

- If it returns `Running`, no action needed.
- If it returns `Nonexistent`, run `finch vm init` (this downloads the VM image and may take a few minutes).
- If it returns `Stopped`, run `finch vm start`.

Wait for the VM to be fully running before proceeding to deployment. A missing or stopped Finch VM will cause Docker image builds to fail during `cdk deploy`.

If Docker is the container runtime, skip these Finch-specific checks — CDK uses Docker by default.

If any check fails, tell the user:
> "Some prerequisites are missing. Please review the project README for setup instructions, then come back when your machine is ready."

Do NOT attempt to install dependencies for the user. Just report what's missing.

Store the AWS identity ARN from the output — it will be used for IAM principal configuration in Phase 4.

Also check the user's AWS profile:

```bash
echo $AWS_PROFILE
```

If set, store it — it will be needed for MCP configuration in Phase 7 and for running `deploy-local.sh`. If not set, ask the user:
> "Which AWS CLI profile should be used for this deployment? (Run `aws configure list-profiles` to see available profiles.)"

IMPORTANT: Once the profile is known (whether from `$AWS_PROFILE` or the user), re-run the identity check with that profile to get the correct ARN for the deployment account:

```bash
aws sts get-caller-identity --profile <profile-name>
```

Use the ARN from THIS output (not the earlier unqualified check) for IAM principal configuration in Phase 4. The default `aws sts get-caller-identity` without `--profile` may return a different account/identity than the one used for deployment.

---

## Phase 2: Choose AWS Region and Deployment Mode

Ask the user:
> "Which AWS region would you like to deploy to? The default is `eu-central-1`."

If the user picks a different region, they will need to set `AWS_REGION` before running the deploy script:
- Both scripts default to `eu-central-1` but respect the `AWS_REGION` environment variable if set

Store the chosen region — it will be needed for MCP configuration later.

Then ask:
> "Which deployment mode would you like to use?
> 1. **Local deploy** — Direct CDK deployment, best for getting started with a single connector
> 2. **Pipeline deploy** — CI/CD pipeline with a config repository, best for production with multiple connectors
>
> Press Enter for local deploy (default)."

Store the deployment mode — it determines the flow for Phases 3-5 and 7.

---

## Phase 3: Configure Catena-X Identity

The configuration approach depends on the deployment mode:

### Option A: Local Deploy (environments.ts)

The user needs to fill in their Catena-X membership details in `cdk/lib/config/environments.ts`.

First, check whether the `edcIam` object inside the first connector entry (`DEPLOYMENT_CONFIG.connectors[0].edcIam`) already has values populated (i.e., fields are not empty strings `""`). If values are already present, show the user the current configuration and ask:
> "The Catena-X identity fields in `environments.ts` are already populated. Would you like to keep the existing values or reconfigure?"

If the user wants to keep existing values, skip to Phase 4.

In a fresh clone, the `edcIam` object has 7 fields all set to empty strings (`""`). These must be populated with values from the Cofinity-X Portal:

| Field | What to ask the user |
|-------|---------------------|
| `TRUSTED_ISSUER` | "What is the trusted issuer DID?" (starts with `did:web:`) |
| `DCP_STS_OAUTH_TOKEN_URL` | "What is your OAuth token endpoint URL?" |
| `DCP_STS_OAUTH_CLIENT_ID` | "What is your technical user's OAuth client ID?" |
| `DCP_STS_DIM_URL` | "What is your DIM integration service URL?" |
| `PARTICIPANT_ID` | "What is your BPNL number?" (e.g., `BPNL000000000001`) |
| `DCP_ID` | "What is your organization's DID?" (starts with `did:web:` — used as both issuer ID and participant ID) |
| `DID_RESOLVER` | "What is your BDRS server URL?" (e.g., `https://bdrs.beta.cofinity-x.com/api/directory`) |

Collect all values from the user, then update the `edcIam` object in `DEPLOYMENT_CONFIG.connectors[0]` in `cdk/lib/config/environments.ts` with the provided values.

### Option B: Pipeline Deploy (YAML config files)

For pipeline deployments, connector identity is configured via YAML files that will be pushed to the config repository. The template is at `cdk/config-templates/connectors/connector-example.yaml`.

For each connector the user wants to deploy, create a `connector-<id>.yaml` in `cdk/config-templates/connectors/`:

```yaml
connectorId: <user-chosen-id>
controlPlaneCpu: 256
controlPlaneMemoryLimitMiB: 1024
dataPlaneCpu: 256
dataPlaneMemoryLimitMiB: 512
stateMachineIterationMillis: "10000"
edcStateRemovalPolicy: DESTROY

edcIam:
  trustedIssuer: "<did:web:...>"
  stsOauthTokenUrl: "<oauth-token-url>"
  stsOauthClientId: "<oauth-client-id>"
  stsDimUrl: "<dim-url>"
  participantId: "<BPNL>"
  dcpId: "<did:web:...>"
  didResolver: "<bdrs-url>"
```

Also update `cdk/config-templates/deployment.yaml` with the IAM principals (Phase 4) and any infrastructure settings.

The `connectorId` must be 2-60 characters, lowercase alphanumeric + hyphens, and cannot start/end with a hyphen. Each connector requires its own set of Cofinity-X Portal credentials.

Collect the same 7 identity fields per connector from the user and write the YAML file(s).

---

## Phase 4: Configure AWS Resources

The user needs to configure IAM access and optionally adjust resource sizing.

### For Local Deploy (environments.ts)

First, check whether `managementApiPrincipals` and `observabilityApiPrincipals` in `DEPLOYMENT_CONFIG.sharedInfra` in `environments.ts` already contain uncommented `ArnPrincipal` entries. If so, show the user the current values and ask:
> "IAM principals are already configured. Would you like to keep the existing values or update them?"

If the user wants to keep existing values, skip to the Optional sections below.

### For Pipeline Deploy (deployment.yaml)

Update `cdk/config-templates/deployment.yaml` to include the IAM principal ARNs:

```yaml
managementApiPrincipals:
  - "arn:aws:iam::<account-id>:role/<role-name>"
observabilityApiPrincipals:
  - "arn:aws:iam::<account-id>:role/<role-name>"
```

### Required: IAM Principals

Ask the user:
> "Which IAM role or user ARN should have access to the Management API? I need the full ARN (e.g., `arn:aws:iam::123456789012:role/MyRole`)."

You can help them find it by running (use the deployment profile identified in Phase 1):
```bash
aws sts get-caller-identity --profile <deployment-profile>
```

The ARN from the output can be used directly. In the blank config, the `managementApiPrincipals` and `observabilityApiPrincipals` arrays contain a commented-out placeholder:

```typescript
// new ArnPrincipal("arn:aws:iam::<account-id>:role/<role-name>"),
```

Uncomment and replace with the user's ARN in both arrays:

```typescript
managementApiPrincipals: [
    new ArnPrincipal("<user-provided-arn>"),
],
observabilityApiPrincipals: [
    new ArnPrincipal("<user-provided-arn>"),
],
```

### Optional: Resource Sizing

Mention to the user:
> "The default resource sizing (256 CPU / 1024 MB for control plane, 256 CPU / 512 MB for data plane) works for most use cases. Let me know if you'd like to adjust these."

Only modify if the user explicitly asks.

---

## Phase 5: Deploy

This project supports two deployment modes:

### Option A: Local Deploy (single connector, direct `cdk deploy`)

Best for getting started quickly with a single connector.

Tell the user:
> "Configuration is complete. I'll now run the deployment. This will build the EDC Java artifacts, install CDK dependencies, bootstrap your AWS account (if needed), and deploy the CloudFormation stacks. This typically takes 10-15 minutes."

IMPORTANT: `deploy-local.sh` is a long-running process (10-15+ minutes). Start it as a background process so you can monitor progress without blocking. The script requires `AWS_PROFILE` and `AWS_REGION` as environment variables — if either is missing, it will prompt interactively, which blocks agent-driven deployments.

ALWAYS export BOTH variables before running the script:

```bash
export AWS_PROFILE=<deployment-profile>
export AWS_REGION=<chosen-region>
./deploy-local.sh
```

Use the profile identified in Phase 1 and the region chosen in Phase 2 (default: `eu-central-1`).

Poll the process output at 30-second intervals to monitor progress. Do NOT poll more frequently — rapid polling generates excessive tool calls and can cause the agent to stall or hit context limits on long deployments. The deployment has these major phases:
1. Gradle build (~30s) — look for `BUILD SUCCESSFUL`
2. npm install + CDK synth (~30s) — look for `Synthesis time`
3. Docker image build + ECR push (~3-5 min) — look for `Published` messages
4. CloudFormation stack creation (~5-10 min) — look for resource creation progress `(N/104)` and final `✅` success marker

This script:
1. Builds the EDC control plane and data plane JARs (`./gradlew clean shadowJar`)
2. Installs CDK dependencies (`npm install`)
3. Bootstraps the AWS account (`cdk bootstrap`)
4. Deploys all stacks (`cdk deploy --all`)

After deployment succeeds, the CDK output will contain the API endpoints. Local deploy creates stacks named `DataspaceConnectorSharedInfraStack` (shared infrastructure) and `DataspaceConnector-<connectorId>` (per-connector resources).

### Option B: Pipeline Deploy (multi-connector, CI/CD with config repo)

Best for production environments with multiple connectors managed via GitOps.

Tell the user:
> "I'll deploy the CI/CD pipeline. This creates a CodePipeline backed by a CodeCommit config repository. You'll manage connector configurations as YAML files in the config repo — the pipeline automatically deploys changes when you push."

The script requires `AWS_PROFILE` and `AWS_REGION`:

```bash
export AWS_PROFILE=<deployment-profile>
export AWS_REGION=<chosen-region>
./deploy-pipeline.sh [config-path]
```

Default config path is `./cdk/config-templates`. The pipeline config requires a `pipeline.yaml` and a `deployment.yaml` in the config path, plus at least one `connectors/connector-<id>.yaml` file.

This script:
1. Installs CDK dependencies and compiles TypeScript
2. Bootstraps the AWS account
3. Deploys `DataspaceConnectorPipelineStack` (the pipeline itself)

The pipeline then:
1. Checks out the config repo (CodeCommit or GitHub)
2. Clones the app repo at the pinned version
3. Builds EDC extensions and synthesizes all stacks
4. Deploys `Deploy-DataspaceConnectorSharedInfraStack` and `Deploy-DataspaceConnector-<connectorId>` for each connector YAML

Pipeline deploy stacks are prefixed with `Deploy-` (the CDK Pipelines stage name).

### Post-Deploy (both modes)

Extract and store these values from the shared infra stack outputs:
- Key starting with `EdcApiManagementApiEndpoint` — the Management API base URL (needed for MCP)
- Key starting with `EdcApiDspApiEndpoint` — the DSP endpoint base URL
- Key starting with `EdcApiDataPlaneApiEndpoint` — data plane endpoint

Each per-connector stack (`<prefix>DataspaceConnector-<connectorId>`) outputs:
- Key `EdcDataPlaneBucketName` — the S3 bucket for that connector's data plane

The per-connector stack also creates a Secrets Manager secret named `<connectorId>/edc.iam.sts.oauth.client.secret` for the OAuth client secret.

---

## Phase 6: Post-Deployment Setup

Tell the user:
> "Deployment is complete. There's one manual step: you need to store your OAuth client secret in AWS Secrets Manager."

Provide the direct console link:
> "Navigate to the AWS Secrets Manager console and update the secret named `<connectorId>/edc.iam.sts.oauth.client.secret` with your OAuth client secret from the Cofinity-X Portal."

Alternatively, they can use the CLI:
```bash
aws secretsmanager put-secret-value \
    --secret-id "<connectorId>/edc.iam.sts.oauth.client.secret" \
    --secret-string '<oauth-client-secret>' \
    --region <chosen-region> \
    --profile <deployment-profile>
```

IMPORTANT: The `--secret-string` value MUST be wrapped in single quotes (`'`), not double quotes (`"`). Secrets often contain `$` or other special characters that bash interprets inside double quotes.

---

## Phase 7: Configure MCP Access

Automatically configure the MCP server using values already collected during this workflow. Do NOT prompt the user — all required values are known:

- `EDC_MANAGEMENT_URL` = the `EdcApiManagementApiEndpoint` from CDK output (Phase 5). Do NOT append a connector ID — in multi-connector mode, routing is handled by the `connector_id` parameter in each tool call.
- `EDC_USE_AWS_IAM` = `"true"` (always — the Management API uses IAM authorization)
- `EDC_MULTI_CONNECTOR` = `"true"` for pipeline deployments with multiple connectors. Set to `"false"` or omit for single-connector local deployments. When enabled, the MCP server uses `list_connectors()` to discover connectors from CloudFormation and requires `connector_id` on all tool calls.
- `AWS_REGION` = the region chosen in Phase 2
- `AWS_PROFILE` = the AWS CLI profile the user used for deployment (from `$AWS_PROFILE` environment variable, or ask the user if not set)
- `--directory` = the absolute path to the `mcp/` subdirectory of this project (resolve from the workspace root)

Write or merge the `dataspace-connector-on-aws` server entry into `.kiro/settings/mcp.json`:

**For multi-connector (pipeline) deployments:**
```json
{
  "mcpServers": {
    "dataspace-connector-on-aws": {
      "command": "uv",
      "args": [
        "--directory",
        "<resolved-absolute-path-to-mcp-directory>",
        "run",
        "dataspace-connector-mcp"
      ],
      "env": {
        "EDC_MANAGEMENT_URL": "<management-api-endpoint-from-cdk-output>",
        "EDC_USE_AWS_IAM": "true",
        "EDC_MULTI_CONNECTOR": "true",
        "AWS_REGION": "<region-from-phase-2>",
        "AWS_PROFILE": "<aws-profile-from-user>"
      }
    }
  }
}
```

**For single-connector (local) deployments:**
```json
{
  "mcpServers": {
    "dataspace-connector-on-aws": {
      "command": "uv",
      "args": [
        "--directory",
        "<resolved-absolute-path-to-mcp-directory>",
        "run",
        "dataspace-connector-mcp"
      ],
      "env": {
        "EDC_MANAGEMENT_URL": "<management-api-endpoint-from-cdk-output>/<connectorId>",
        "EDC_USE_AWS_IAM": "true",
        "AWS_REGION": "<region-from-phase-2>",
        "AWS_PROFILE": "<aws-profile-from-user>"
      }
    }
  }
}
```

Note: In single-connector mode, the connector ID is appended to the management URL directly. In multi-connector mode, it is omitted from the URL and passed as `connector_id` parameter to each MCP tool call.

If `.kiro/settings/mcp.json` already exists, preserve other server entries and only add/update the `dataspace-connector-on-aws` key. If the `dataspace-connector-on-aws` entry already exists (e.g., from a previous deployment), update ALL env values to match the current deployment — do not leave stale values from a prior region or account.

---

## Phase 8: Validate MCP Access

After the user restarts the MCP server (or Kiro picks it up automatically), validate the connection.

**For multi-connector mode**, first verify discovery works:
```python
list_connectors()
```

This should return the list of deployed connector IDs. Then validate one connector:
```python
query_assets(connector_id="<connectorId>", limit=1)
```

Then validate the DSP endpoint by requesting the connector's own catalog:
```python
request_catalog(
    connector_id="<connectorId>",
    counter_party_address="<EdcApiDspApiEndpoint from CDK output>/<connectorId>",
    counter_party_id="<PARTICIPANT_ID from Phase 3>"
)
```

**For single-connector mode**, omit `connector_id`:
```python
query_assets(limit=1)
```

Then validate the DSP endpoint:
```python
request_catalog(
    counter_party_address="<EdcApiDspApiEndpoint from CDK output>/<connectorId>",
    counter_party_id="<PARTICIPANT_ID from Phase 3>"
)
```

If both calls succeed, tell the user:
> "Your Dataspace Connector is deployed and the MCP tools are connected. You can now create data offerings, browse catalogs, negotiate contracts, and transfer data using the 19 available tools."

If either call fails, check:
- AWS credentials are valid and not expired
- IAM principal ARN matches what was configured in `managementApiPrincipals`
- Management API URL is correct (should end with `/management/` for multi-connector, or `/management/<connectorId>` for single-connector)
- Region matches the deployment region
- For multi-connector: `EDC_MULTI_CONNECTOR=true` is set in the MCP env config
