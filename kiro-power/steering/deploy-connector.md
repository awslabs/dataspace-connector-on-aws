# Deploy Connector Workflow

This steering file guides the agent through deploying a Dataspace Connector on AWS from scratch. Follow each phase in order. Ask the user for input where indicated.

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

- If it's already set to `finch`, no action needed.
- If it's empty, uncomment `export CDK_DOCKER=finch` in `deploy.sh`.

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

If set, store it — it will be needed for MCP configuration in Phase 7 and for running `deploy.sh`. If not set, ask the user:
> "Which AWS CLI profile should be used for this deployment? (Run `aws configure list-profiles` to see available profiles.)"

IMPORTANT: Once the profile is known (whether from `$AWS_PROFILE` or the user), re-run the identity check with that profile to get the correct ARN for the deployment account:

```bash
aws sts get-caller-identity --profile <profile-name>
```

Use the ARN from THIS output (not the earlier unqualified check) for IAM principal configuration in Phase 4. The default `aws sts get-caller-identity` without `--profile` may return a different account/identity than the one used for deployment.

---

## Phase 2: Choose AWS Region

Ask the user:
> "Which AWS region would you like to deploy to? The default is `eu-central-1`."

If the user picks a different region, update `deploy.sh`:
- Change `export AWS_REGION=eu-central-1` to their chosen region

Store the chosen region — it will be needed for MCP configuration later.

---

## Phase 3: Configure Catena-X Identity

The user needs to fill in their Catena-X membership details in `cdk/lib/config/environments.ts`.

First, check whether the `edcIam` object already has values populated (i.e., fields are not empty strings `""`). If values are already present, show the user the current configuration and ask:
> "The Catena-X identity fields in `environments.ts` are already populated. Would you like to keep the existing values or reconfigure?"

If the user wants to keep existing values, skip to Phase 4.

In a fresh clone, the `edcIam` object has 7 fields all set to empty strings (`""`). These must be populated with values from the Cofinity-X Portal:

| Field | What to ask the user |
|-------|---------------------|
| `DID_RESOLVER` | "What is your BDRS server URL?" (e.g., `https://bdrs.beta.cofinity-x.com/api/directory`) |
| `DIM_URL` | "What is your DIM integration service URL?" |
| `IATP_ID` | "What is your organization's DID?" (starts with `did:web:`) |
| `OAUTH_CLIENT_ID` | "What is your technical user's OAuth client ID?" |
| `OAUTH_TOKEN_URL` | "What is your OAuth token endpoint URL?" |
| `PARTICIPANT_ID` | "What is your BPNL number?" (e.g., `BPNL000000000001`) |
| `TRUSTED_ISSUER_ID` | "What is the trusted issuer DID?" (starts with `did:web:`) |

Collect all values from the user, then update the `edcIam` object in `cdk/lib/config/environments.ts` with the provided values.

---

## Phase 4: Configure AWS Resources

The user needs to configure IAM access and optionally adjust resource sizing.

First, check whether `managementApiPrincipals` and `observabilityApiPrincipals` in `environments.ts` already contain uncommented `ArnPrincipal` entries. If so, show the user the current values and ask:
> "IAM principals are already configured. Would you like to keep the existing values or update them?"

If the user wants to keep existing values, skip to the Optional sections below.

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

### Optional: Management API Key

Inform the user:
> "The `managementApiAuthKey` is currently set to an empty string, which is fine since IAM auth is already enabled. Would you like to set an additional EDC API key? This adds an extra `x-api-key` header requirement on top of IAM auth. Press Enter to skip."

If they provide a value, update `managementApiAuthKey` in `environments.ts`. Store this value — it's needed for MCP configuration later.

### Optional: Resource Sizing

Mention to the user:
> "The default resource sizing (256 CPU / 1024 MB for control plane, 256 CPU / 512 MB for data plane) works for most use cases. Let me know if you'd like to adjust these."

Only modify if the user explicitly asks.

---

## Phase 5: Deploy

Tell the user:
> "Configuration is complete. I'll now run the deployment. This will build the EDC Java artifacts, install CDK dependencies, bootstrap your AWS account (if needed), and deploy the CloudFormation stack. This typically takes 10-15 minutes."

IMPORTANT: `deploy.sh` is a long-running process (10-15+ minutes). Start it as a background process so you can monitor progress without blocking. If a specific AWS profile is needed, prepend it to the command:

```bash
AWS_PROFILE=<deployment-profile> ./deploy.sh
```

If `$AWS_PROFILE` is already exported in the user's shell, you can run `./deploy.sh` directly.

Poll the process output at 30-second intervals to monitor progress. Do NOT poll more frequently — rapid polling generates excessive tool calls and can cause the agent to stall or hit context limits on long deployments. The deployment has these major phases:
1. Gradle build (~30s) — look for `BUILD SUCCESSFUL`
2. npm install + CDK synth (~30s) — look for `Synthesis time`
3. Docker image build + ECR push (~3-5 min) — look for `Published` messages
4. CloudFormation stack creation (~5-10 min) — look for resource creation progress `(N/104)` and final `✅` success marker

This script:
1. Builds the EDC control plane and data plane JARs (`./gradlew clean shadowJar`)
2. Installs CDK dependencies (`npm install`)
3. Bootstraps the AWS account (`cdk bootstrap`)
4. Deploys the stack (`cdk deploy`)

After deployment succeeds, the CDK output will contain the API endpoints. Extract and store these values:
- `EdcApiManagementApiEndpoint` — needed for MCP configuration
- `EdcApiDspApiEndpoint` — the DSP endpoint for catalog requests
- `EdcApiDataPlaneApiEndpoint` — data plane endpoint
- `EdcOauthClientSecretArn` — Secrets Manager ARN for the OAuth secret

---

## Phase 6: Post-Deployment Setup

Tell the user:
> "Deployment is complete. There's one manual step: you need to store your OAuth client secret in AWS Secrets Manager."

Provide the direct console link:
> "Navigate to the AWS Secrets Manager console and update the secret at `EdcOauthClientSecretArn` (shown in the deployment output) with your OAuth client secret from the Cofinity-X Portal."

Alternatively, they can use the CLI:
```bash
aws secretsmanager put-secret-value \
    --secret-id "<EdcOauthClientSecretArn from output>" \
    --secret-string '<oauth-client-secret>' \
    --region <chosen-region> \
    --profile <deployment-profile>
```

IMPORTANT: The `--secret-string` value MUST be wrapped in single quotes (`'`), not double quotes (`"`). Secrets often contain `$` or other special characters that bash interprets inside double quotes.

---

## Phase 7: Configure MCP Access

Automatically configure the MCP server using values already collected during this workflow. Do NOT prompt the user — all required values are known:

- `EDC_MANAGEMENT_URL` = the `EdcApiManagementApiEndpoint` from CDK output (Phase 5)
- `EDC_API_KEY` = the `managementApiAuthKey` from Phase 4 (empty string if skipped)
- `AWS_REGION` = the region chosen in Phase 2
- `AWS_PROFILE` = the AWS CLI profile the user used for deployment (from `$AWS_PROFILE` environment variable, or ask the user if not set)
- `--directory` = the absolute path to the `mcp/` subdirectory of this project (resolve from the workspace root)

Write or merge the `dataspace-connector-on-aws` server entry into `.kiro/settings/mcp.json`:

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
        "EDC_API_KEY": "<management-api-auth-key-from-phase-4>",
        "EDC_USE_AWS_IAM": "true",
        "AWS_REGION": "<region-from-phase-2>",
        "AWS_PROFILE": "<aws-profile-from-user>"
      }
    }
  }
}
```

If `.kiro/settings/mcp.json` already exists, preserve other server entries and only add/update the `dataspace-connector-on-aws` key. If the `dataspace-connector-on-aws` entry already exists (e.g., from a previous deployment), update ALL env values to match the current deployment — do not leave stale values from a prior region or account.

---

## Phase 8: Validate MCP Access

After the user restarts the MCP server (or Kiro picks it up automatically), validate the connection by running a simple query:

```
query_assets(limit=1)
```

If this returns successfully (even an empty list), the MCP connection is working.

Then validate the DSP endpoint by requesting the connector's own catalog:

```
request_catalog(
    counter_party_address="<EdcApiDspApiEndpoint from CDK output>",
    counter_party_id="<PARTICIPANT_ID from Phase 3>"
)
```

If both calls succeed, tell the user:
> "Your Dataspace Connector is deployed and the MCP tools are connected. You can now create data offerings, browse catalogs, negotiate contracts, and transfer data using the 14 available tools."

If either call fails, check:
- AWS credentials are valid and not expired
- IAM principal ARN matches what was configured
- Management API URL is correct (should end with `/management/`)
- Region matches the deployment region
