# Validate Data Exchange Workflow

This steering file guides the agent through validating the data exchange capabilities of a deployed Dataspace Connector. The connector must already be deployed and MCP tools connected (see the **deploy-connector** steering file).

This workflow verifies the full data exchange flow end-to-end: creating data offerings, browsing catalogs, negotiating contracts, transferring data, and fetching the actual payload through the data plane.

The default validation uses Amazon S3 as the data source, which exercises the full AWS-native data path (IAM roles, S3 data plane extension, token signing). An HttpData alternative is also available for quick smoke tests against external URLs.

The MCP server exposes 12 general-purpose primitives. Resource reads use one generic `get_resource(resource_type, resource_id)` and resource lists use one generic `query_resources(resource_type, ...)`; the `resource_type` values are `assets`, `policy_definitions`, `contract_definitions`, `contract_negotiations`, `contract_agreements`, and `transfer_processes` (plus `edr` for `get_resource`).

---

## Phase 1: Verify Connectivity

Before starting, confirm the MCP tools are working and identify the target connector.

### Step 1.1: Identify the Target Connector

All connectors are deployed by the pipeline, so their stacks are named `DataspaceConnector-SharedInfra` (shared infrastructure) and `DataspaceConnector-Connector-<connectorId>` (per connector).

Use `list_connectors()` to discover the deployed connector IDs (it scans CloudFormation for `DataspaceConnector-Connector-` stacks) and ask the user which one to validate. It also returns `management_base_url` and `dsp_base_url`; a connector's DSP address is `{dsp_base_url}/{connectorId}`. All MCP tool calls include the `connector_id` parameter.

### Step 1.2: Verify MCP Connectivity

Run a quick check against the target connector:
```python
query_resources(connector_id="<target-connector>", resource_type="assets", limit=1)
```

If this fails, the MCP connection isn't configured. Direct the user to the **deploy-connector** steering file first.

### Step 1.3: Discover CloudWatch Log Groups

The AWS profile and region are needed, check the MCP config at `.kiro/settings/mcp.json` for `AWS_PROFILE` and `AWS_REGION` values:

```bash
aws cloudformation list-stack-resources --stack-name DataspaceConnector-Connector-<connectorId> --region <region> \
    --query 'StackResourceSummaries[?ResourceType==`AWS::Logs::LogGroup`].[LogicalResourceId,PhysicalResourceId]' --output json
```

This returns the log group physical resource IDs for the current deployment. Match by logical ID prefix:
- `ControlPlane` → control plane log group
- `DataPlane` → data plane log group

Store both log group names, they are needed for diagnosing any issues in Phase 8.

---

## Phase 2: Understand the User's Goal

Ask the user:
> "What would you like to do? The recommended first step is a full end-to-end validation using the loopback self-test, this creates a data offering on your connector and then consumes it from the same connector, verifying the entire flow.
>
> 1. **End-to-end validation with S3 (recommended)**: Uploads test data to S3, registers it as an asset, and validates the full AWS-native data path including S3 proxy, IAM roles, and token signing
> 2. **Quick validation with HttpData**: Lighter self-test using an external HTTP endpoint as the data source (skips S3)
> 3. **Create a data offering**: Register an asset, define access policies, and publish a contract offer so other connectors can discover and consume your data
> 4. **Consume data from another connector**: Browse a provider's catalog, negotiate a contract, and transfer data
>
> Press Enter for the recommended S3 end-to-end validation, or choose another option."

If the user picks option 1 or presses Enter, proceed to Phase 5 (Self-Test with S3 Loopback).
If option 2, proceed to Phase 6 (Quick Validation with HttpData).
Otherwise, proceed to the relevant phase based on their answer.

---

## Phase 3: Create a Data Offering (Provider Side)

Walk the user through creating a complete data offering. Ask for details or use sensible defaults.

### Step 3.1: Define Policies

Tractus-X EDC requires separate access and usage policies with Catena-X-compliant constraints. Ask the user:
> "What access policy should govern your data? Common options:
> - **Open access**: Any Catena-X member can see and use the data (good for testing)
> - **BPN-restricted**: Only specific business partners can access it
>
> For validation, open access is simplest. Want to go with that?"

For open access, create two policies, one for access (who can see the offer) and one for usage (who can negotiate a contract):

**Access policy** (controls catalog visibility):
```python
create_policy(
    connector_id="<target-connector>",
    policy_id="<user-chosen-id-or-default>-access",
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
```

**Usage/contract policy** (controls negotiation, requires FrameworkAgreement + UsagePurpose):
```python
create_policy(
    connector_id="<target-connector>",
    policy_id="<user-chosen-id-or-default>-usage",
    policy={
        "@type": "Set",
        "permission": [{
            "action": "use",
            "constraint": [{
                "and": [
                    {
                        "leftOperand": "FrameworkAgreement",
                        "operator": "eq",
                        "rightOperand": "DataExchangeGovernance:1.0"
                    },
                    {
                        "leftOperand": "UsagePurpose",
                        "operator": "isAnyOf",
                        "rightOperand": "cx.core.industrycore:1"
                    }
                ]
            }]
        }]
    }
)
```

The Catena-X policy context is added by the tool automatically. Each call returns an `IdResponse` with the policy `@id`. For BPN-restricted access, replace the access policy's `Membership` constraint with a `BusinessPartnerNumber` constraint targeting the allowed BPNL.

### Step 3.2: Create an Asset

Ask the user what type of data source they want to use:

#### Option A: Amazon S3 data source

The user needs to provide:
- Asset ID and name
- S3 bucket name, object key, and region

```python
create_asset(
    connector_id="<target-connector>",
    asset_id="<user-chosen-id>",
    properties={
        "name": "<user-provided-name>",
        "description": "<user-provided-description>",
        "contentType": "<content-type>"
    },
    data_address={
        "type": "AmazonS3",
        "region": "<aws-region>",
        "bucketName": "<bucket-name>",
        "objectName": "<object-key>"
    }
)
```

#### Option B: HTTP data source

The user needs to provide:
- Asset ID and name
- The data source URL

If the user doesn't have a real data source, suggest a placeholder:
> "For testing, we can use a public test endpoint like `https://jsonplaceholder.typicode.com/posts` as the data source."

```python
create_asset(
    connector_id="<target-connector>",
    asset_id="<user-chosen-id>",
    properties={
        "name": "<user-provided-name>",
        "description": "<user-provided-description>",
        "contentType": "<content-type>"
    },
    data_address={
        "type": "HttpData",
        "baseUrl": "<data-source-url>"
    }
)
```

### Step 3.3: Create a Contract Definition

Link the asset to both policies:

```python
create_contract_definition(
    connector_id="<target-connector>",
    contract_definition_id="<user-chosen-id>",
    access_policy_id="<access-policy-id-from-step-3.1>",
    contract_policy_id="<usage-policy-id-from-step-3.1>",
    assets_selector=[{
        "operandLeft": "https://w3id.org/edc/v0.0.1/ns/id",
        "operator": "=",
        "operandRight": "<asset-id-from-step-3.2>"
    }]
)
```

After creation, confirm:
> "Your data offering is live. Other connectors can now discover it via your DSP endpoint. Want to verify by browsing your own catalog?"

---

## Phase 4: Consume Data from Another Connector (Consumer Side)

### Step 4.1: Browse the Catalog

Ask the user:
> "What's the DSP endpoint of the provider connector you want to browse? (e.g., `https://<api-id>.execute-api.<region>.amazonaws.com/protocol/<connectorId>`)
> And what's their participant ID (BPNL)?"

```python
request_catalog(
    connector_id="<target-connector>",
    counter_party_address="<provider-dsp-endpoint>",
    counter_party_id="<provider-bpnl>"
)
```

Help the user interpret the catalog response:
- Each `dcat:dataset` entry is an available asset
- The `odrl:hasPolicy` contains the offer details needed for negotiation
- Point out the offer ID (`@id` of the policy), asset ID, and the `odrl:permission`/`odrl:prohibition`/`odrl:obligation` values

### Step 4.2: Negotiate a Contract

Using the catalog response, extract the offer details and negotiate:

```python
initiate_negotiation(
    connector_id="<target-connector>",
    counter_party_address="<provider-dsp-endpoint>",
    offer_id="<@id from odrl:hasPolicy>",
    asset_id="<asset-id from catalog>",
    assigner="<provider-bpnl>",
    permission=<odrl:permission from offer>,
    prohibition=<odrl:prohibition from offer>,
    obligation=<odrl:obligation from offer>
)
```

IMPORTANT: The `permission`, `prohibition`, and `obligation` must be passed through exactly as they appear in the catalog offer. Do not construct a minimal stub, the provider will reject it with "Policy not equal to offer".

### Step 4.3: Wait for Negotiation to Complete

Poll the negotiation state with the generic read primitive:
```python
get_resource(connector_id="<target-connector>", resource_type="contract_negotiations", resource_id="<negotiation-id>")
```

Expected state progression: `INITIAL` → `REQUESTED` → `AGREED` → `VERIFIED` → `FINALIZED`

If the state is `TERMINATED`, check the `errorDetail` field in the response. Common causes:
- Policy mismatch (didn't pass full policy from catalog)
- Provider-side policy evaluation failure (BPN not allowed)

Once `FINALIZED`, read the `contractAgreementId` directly from the same response, `get_resource` returns the full negotiation object (the agreement id is often present already at `VERIFIED`).

### Step 4.4: Retrieve the Agreement

```python
get_resource(connector_id="<target-connector>", resource_type="contract_agreements", resource_id="<contract-agreement-id>")
```

### Step 4.5: Transfer Data

```python
initiate_transfer(
    connector_id="<target-connector>",
    counter_party_address="<provider-dsp-endpoint>",
    contract_id="<agreement-id>",
    transfer_type="HttpData-PULL"
)
```

For `HttpData-PULL`, the MCP server automatically sets the data destination to `{"type": "HttpProxy"}`.

### Step 4.6: Get the Data

Poll until the transfer reaches `STARTED`:
```python
get_resource(connector_id="<target-connector>", resource_type="transfer_processes", resource_id="<transfer-id>")
```

If the transfer state is `TERMINATED` instead of progressing to `STARTED`, do NOT retry blindly. Follow the troubleshooting procedure in Phase 8 to diagnose the root cause.

Once `STARTED`, fetch the payload with `fetch_data`, which resolves the EDR and makes the HTTP request to the provider's data plane in one step:

```python
fetch_data(connector_id="<target-connector>", transfer_process_id="<transfer-id>")
```

`fetch_data` returns `{status, headers, body}`. It appends the Tractus-X public API sub-path `public/` to the EDR endpoint by default (the endpoint looks like `.../data/<connectorId>/`, and the public API is at `.../data/<connectorId>/public/`); pass an explicit `path` only if the asset needs a different sub-path. It refreshes the EDR token transparently, so the agent can call it repeatedly over time without worrying about token expiry.

The data plane acts as a proxy, it forwards the request to the provider's actual data source (the `baseUrl` or S3 object configured in the asset's data address) and returns the response. If the response body contains the expected data from the asset's data source, the end-to-end flow is validated.

For advanced use cases (sub-paths, query parameters, POST bodies), `fetch_data` accepts `method`, `path`, `query_params`, and `body`:

```python
fetch_data(
    connector_id="<target-connector>",
    transfer_process_id="<transfer-id>",
    method="GET",
    path="/public/items",
    query_params={"limit": "10"}
)
```

To inspect the raw EDR (endpoint URL, authorization token, refresh endpoint, token expiry) without fetching, read it as a resource:

```python
get_resource(connector_id="<target-connector>", resource_type="edr", resource_id="<transfer-id>")
```

---

## Phase 5: Self-Test with S3 Loopback (Recommended)

This is the recommended validation path. It exercises the full AWS-native data flow: S3 upload → asset registration → catalog → negotiation → transfer → EDR → data plane S3 proxy → consumer HTTP download.

### Step 5.1: Discover Stack Resources

Retrieve the S3 bucket name, DSP endpoint, and BPNL. The DSP endpoint also comes from `list_connectors` (`{dsp_base_url}/{connectorId}`); the bucket comes from the per-connector stack.

**Shared infrastructure outputs** (the DSP endpoint is shared across all connectors):

```bash
aws cloudformation describe-stacks --stack-name DataspaceConnector-SharedInfra --region <region> \
    --query "Stacks[0].Outputs" --output json
```

Extract:
- `DspApiUrl` → the DSP endpoint base URL. Append the connector ID to form the full DSP address (e.g., `https://xxx.execute-api.<region>.amazonaws.com/protocol/<connectorId>`).
- `ManagementApiUrl` → the Management API base URL (for reference).

**Per-connector output** (the S3 bucket for this connector's data plane):

```bash
aws cloudformation describe-stacks --stack-name DataspaceConnector-Connector-<connectorId> --region <region> \
    --query "Stacks[0].Outputs[?OutputKey=='EdcDataPlaneBucketName'].OutputValue" --output text
```

**Business Partner Number (BPN):** the organization BPN is the `participantId` under `portal.identity` in `deployment.yaml` in the configuration repository. It is the deployment-wide default (a connector may override it under its own `portal.identity`). Fetch it from CodeCommit:

```bash
aws codecommit get-file --repository-name DataspaceConnector-config \
    --file-path deployment.yaml --region <region> --query 'fileContent' --output text | base64 -d
```

Use the BPN as the `counter_party_id` for catalog requests and as the `assigner` for contract negotiations. If you already have these values from deployment, use them directly.

### Step 5.2: Upload Test Data to S3

Generate a short generic test document and upload it to the stack's S3 bucket:

```bash
echo '{"id":"test-001","name":"Sample Record","description":"Test data for validating the dataspace connector S3 data exchange.","value":42,"timestamp":"2025-01-01T00:00:00Z"}' \
    | aws s3 cp - "s3://<bucket-name>/test/sample-data.json" \
    --content-type "application/json" \
    --region <region> \
    --profile <deployment-profile>
```

Verify the upload:
```bash
aws s3 ls "s3://<bucket-name>/test/sample-data.json" --region <region> --profile <deployment-profile>
```

### Step 5.3: Create the S3 Test Offering

Create an access policy, usage policy, asset, and contract definition for the test data:

**Access policy** (Membership check):
```python
create_policy(
    connector_id="<target-connector>",
    policy_id="test-s3-access-policy",
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
```

**Usage policy** (FrameworkAgreement + UsagePurpose):
```python
create_policy(
    connector_id="<target-connector>",
    policy_id="test-s3-usage-policy",
    policy={
        "@type": "Set",
        "permission": [{
            "action": "use",
            "constraint": [{
                "and": [
                    {
                        "leftOperand": "FrameworkAgreement",
                        "operator": "eq",
                        "rightOperand": "DataExchangeGovernance:1.0"
                    },
                    {
                        "leftOperand": "UsagePurpose",
                        "operator": "isAnyOf",
                        "rightOperand": "cx.core.industrycore:1"
                    }
                ]
            }]
        }]
    }
)
```

**Asset with S3 data address:**
```python
create_asset(
    connector_id="<target-connector>",
    asset_id="test-s3-asset",
    properties={
        "name": "Test S3 Dataset",
        "description": "Test dataset stored in S3 for validating the connector",
        "contentType": "application/json"
    },
    data_address={
        "type": "AmazonS3",
        "region": "<region>",
        "bucketName": "<bucket-name>",
        "objectName": "test/sample-data.json"
    }
)
```

**Contract definition** (links asset to both policies):
```python
create_contract_definition(
    connector_id="<target-connector>",
    contract_definition_id="test-s3-contract-def",
    access_policy_id="test-s3-access-policy",
    contract_policy_id="test-s3-usage-policy",
    assets_selector=[{
        "operandLeft": "https://w3id.org/edc/v0.0.1/ns/id",
        "operator": "=",
        "operandRight": "test-s3-asset"
    }]
)
```

### Step 5.4: Browse Own Catalog

```python
request_catalog(
    connector_id="<target-connector>",
    counter_party_address="<own-dsp-endpoint>",
    counter_party_id="<own-bpnl>"
)
```

Locate the `test-s3-asset` entry in the catalog response and extract the offer details. Note that the `dspace:participantId` in the catalog response is the BPNL, and the `assigner` in the offer also uses the BPNL, use this value for `counter_party_id` and `assigner` in subsequent steps.

### Step 5.5: Complete the Consumer Flow

Follow Phase 4 steps 4.2 through 4.6 using the user's own connector as both provider and consumer, targeting the `test-s3-asset` offer from the catalog.

### Step 5.6: Verify the Payload

After `fetch_data` returns the data, verify the `body` matches the document uploaded in Step 5.2. The response body should be:
```json
{"id":"test-001","name":"Sample Record","description":"Test data for validating the dataspace connector S3 data exchange.","value":42,"timestamp":"2025-01-01T00:00:00Z"}
```

After successful completion:
> "Your connector is fully operational, the complete S3 data exchange flow has been validated end-to-end. Data was uploaded to S3, registered as an asset, discovered via catalog, negotiated, transferred, and retrieved through the data plane proxy. The data plane successfully read from S3 using its IAM role and proxied the content to the consumer over HTTP. You're ready to start sharing data with other Catena-X participants."

---

## Phase 6: Quick Validation with HttpData Loopback

This is a lighter alternative to the S3 self-test. It uses an external HTTP endpoint as the data source, which validates the core EDC flow (catalog, negotiation, transfer, EDR, proxy) but does not exercise the S3 data plane extension or IAM roles.

### Step 6.1: Create a Test Offering

Use Phase 3 with these defaults (or let the user customize):
- Policy IDs: `test-access-policy`, `test-usage-policy`
- Asset ID: `test-asset`
- Asset name: "Test Dataset"
- Data source: `https://jsonplaceholder.typicode.com/posts`
- Content type: `application/json`
- Contract definition ID: `test-contract-def`

### Step 6.2: Browse Own Catalog

Retrieve the DSP endpoint and BPNL as described in Phase 5 Step 5.1, then:

```python
request_catalog(
    connector_id="<target-connector>",
    counter_party_address="<own-dsp-endpoint>",
    counter_party_id="<own-bpnl>"
)
```

### Step 6.3: Complete the Flow

Follow Phase 4 steps 4.2 through 4.6 using the user's own connector as both provider and consumer.

After successful completion:
> "Your connector's core data exchange flow is working, catalog, negotiation, transfer, and HTTP proxy are all operational. For a more thorough validation that includes S3 data sources, run the S3 self-test (option 1)."

---

## Phase 7: Inspect and Clean Up

After testing, help the user review what was created. All collections are read with the generic list primitive:

```python
query_resources(connector_id="<target-connector>", resource_type="assets", limit=50)
query_resources(connector_id="<target-connector>", resource_type="policy_definitions", limit=50)
query_resources(connector_id="<target-connector>", resource_type="contract_definitions", limit=50)
query_resources(connector_id="<target-connector>", resource_type="contract_negotiations", limit=50)
query_resources(connector_id="<target-connector>", resource_type="contract_agreements", limit=50)
query_resources(connector_id="<target-connector>", resource_type="transfer_processes", limit=50)
```

> [!NOTE]
> When filtering `query_resources` by `state`, pass EDC's integer state code as a number (for example `600`=STARTED, `850`=TERMINATED), not the string label, which does not match. (`manage_transfer` with `all_started` uses `state=600` to select STARTED transfers.)

### Deleting test resources

Assets, policy definitions, and contract definitions can be removed with `delete_resource`:

```python
delete_resource(connector_id="<target-connector>", resource_type="contract_definitions", resource_id="test-s3-contract-def")
delete_resource(connector_id="<target-connector>", resource_type="policy_definitions", resource_id="test-s3-usage-policy")
delete_resource(connector_id="<target-connector>", resource_type="policy_definitions", resource_id="test-s3-access-policy")
delete_resource(connector_id="<target-connector>", resource_type="assets", resource_id="test-s3-asset")
```

Delete the contract definition first (it removes the offer from the catalog), then the policies, then the asset. An asset that is referenced by a finalized contract agreement returns 409 and cannot be deleted until the agreement is gone, this is expected, and the agreement itself is immutable. Negotiations and agreements have no delete operation.

### Ending transfers (and controlling cost)

Transfers are not deleted; they are ended with `manage_transfer`. This matters on this project because open pull transfers keep a provider-side data-plane flow active and continue to consume DynamoDB (see the **open-transfers-and-dynamodb-cost** doc), so terminate transfers you no longer need:

```python
# End one transfer
manage_transfer(connector_id="<target-connector>", transfer_process_id="<transfer-id>", action="terminate", reason="test complete")

# End every STARTED transfer at once (cost cleanup)
manage_transfer(connector_id="<target-connector>", transfer_process_id="all_started", action="terminate", reason="idle cleanup")
```

`suspend` and `resume` also exist, but for `HttpData-PULL` transfers `resume` may not restore `STARTED` (the transfer can move to `TERMINATED`); `terminate` is the reliable action.

Any leftover S3 test objects uploaded during the S3 self-test can be removed with `aws s3 rm`. For a full reset, the user can redeploy the stack (DynamoDB tables use the `DESTROY` removal policy by default).

---

## Phase 8: Troubleshooting

When any EDC operation reaches an unexpected state (e.g., transfer `TERMINATED` instead of `STARTED`, negotiation `TERMINATED` instead of `FINALIZED`), follow this systematic approach. Do NOT retry or restart services without first collecting and interpreting logs.

### Step 8.1: Query the Failed Process for Error Details

For a failed transfer, first get the full transfer process object which includes `errorDetail` and `correlationId`:

```python
get_resource(connector_id="<target-connector>", resource_type="transfer_processes", resource_id="<consumer-transfer-id>")
```

Extract the `correlationId` from the response, then query the provider-side transfer process by id:

```python
query_resources(connector_id="<target-connector>", resource_type="transfer_processes", filter_expression=[{
    "operandLeft": "id",
    "operator": "=",
    "operandRight": "<correlationId>"
}])
```

The provider-side response contains the `errorDetail` field with the actual error message. The consumer side typically does not include error details.

For a failed negotiation, get the full negotiation object directly:
```python
get_resource(connector_id="<target-connector>", resource_type="contract_negotiations", resource_id="<negotiation-id>")
```

The response includes the `errorDetail` field when the negotiation is `TERMINATED`.

### Step 8.2: Discover CloudWatch Log Groups

The control plane and data plane each write to their own CloudWatch log group. The names include CDK-generated suffixes, so discover them from the stack resources (this avoids picking up stale log groups from prior deployments):

```bash
aws cloudformation list-stack-resources --stack-name DataspaceConnector-Connector-<connectorId> --region <region> \
    --query 'StackResourceSummaries[?ResourceType==`AWS::Logs::LogGroup`].[LogicalResourceId,PhysicalResourceId]' --output json
```

This returns entries like:
- Logical ID containing `ControlPlane` → `DataspaceConnector-Connector-<connectorId>-ControlPlaneLogGroup<suffix>`
- Logical ID containing `DataPlane` → `DataspaceConnector-Connector-<connectorId>-DataPlaneLogGroup<suffix>`

Store both, you'll need them for log queries.

### Step 8.3: Pull Time-Correlated Logs from Both Services

Using the timestamp from the failed process (the `stateTimestamp` field from Step 8.1), pull logs from BOTH the control plane and data plane in a window around that time. Always check both services, the root cause may be on either side.

First, find the latest log stream for each service:
```bash
aws logs describe-log-streams --log-group-name "<log-group-name>" --region <region> \
    --order-by LastEventTime --descending --limit 1 \
    --query 'logStreams[0].logStreamName' --output text
```

Then pull logs in the time window (use the `stateTimestamp` ± 30 seconds):
```bash
aws logs get-log-events --log-group-name "<log-group-name>" --region <region> \
    --log-stream-name "<stream-name>" \
    --start-time <stateTimestamp - 30000> --end-time <stateTimestamp + 30000> \
    --limit 50 --output json --query 'events[*].[timestamp,message]'
```

You can also filter for specific patterns:
```bash
aws logs filter-log-events --log-group-name "<log-group-name>" --region <region> \
    --start-time <start> --end-time <end> \
    --filter-pattern "<keyword>" \
    --output json --query 'events[*].[timestamp,message]'
```

Useful filter patterns: `SEVERE`, `WARNING`, `ERROR`, `DataPlane`, `TransferProcess`, `ContractNegotiation`.

### Step 8.4: Interpret and Act

With the error detail from Step 8.1 and the correlated logs from Step 8.3, interpret the root cause before taking action. Common patterns:

| Error Detail | Likely Cause | Where to Look |
|---|---|---|
| `DataPlane not found` | Data plane registration expired or data plane not running | Control plane logs for `DataPlaneSelectorManagerImpl` state changes; data plane logs for `DataPlaneHealthCheck` registration |
| `Policy not equal to offer` | Contract negotiation used a policy that doesn't match the catalog offer | Control plane logs for policy evaluation; verify the `permission`/`prohibition`/`obligation` passed to `initiate_negotiation` match the catalog exactly |
| `Contract agreement not found` | Invalid or expired contract agreement ID used for transfer | Control plane logs; verify the agreement ID exists via `get_resource(resource_type="contract_agreements", ...)` |
| `Failed to decode token` | Token signing key mismatch between control plane and data plane | Verify the Secrets Manager secrets `<deploymentName>/<connectorId>/edc.transfer.proxy.token.signer.privatekey` and `<deploymentName>/<connectorId>/edc.transfer.proxy.token.verifier.publickey` exist and contain valid RSA keys (these are auto-generated on first deploy by the `EdcTokenKeyPair` construct, if missing, redeploy the connector stack) |
| S3 `AccessDenied` | Data plane Fargate task role lacks `s3:GetObject` permission on the bucket | Check the task role policies; verify the bucket ARN matches |
| No logs in data plane | Data plane task may have crashed or not started | Check ECS service status: `aws ecs describe-services --cluster <cluster> --services <service>` |

IMPORTANT: Always collect logs from BOTH services before drawing conclusions. Do not restart services or retry operations without understanding the root cause first.
