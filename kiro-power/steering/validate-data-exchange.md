# Validate Data Exchange Workflow

This steering file guides the agent through validating the data exchange capabilities of a deployed Dataspace Connector. The connector must already be deployed and MCP tools connected (see the **deploy-connector** steering file).

This workflow verifies the full data exchange flow end-to-end: creating data offerings, browsing catalogs, negotiating contracts, transferring data, and fetching the actual payload through the data plane.

The default validation uses Amazon S3 as the data source, which exercises the full AWS-native data path (IAM roles, S3 data plane extension, token signing). An HttpData alternative is also available for quick smoke tests against external URLs.

---

## Phase 1: Verify Connectivity

Before starting, confirm the MCP tools are working.

Run a quick check:
```
query_assets(limit=1)
```

If this fails, the MCP connection isn't configured. Direct the user to the **deploy-connector** steering file first.

Also discover the CloudWatch log groups for troubleshooting later. The AWS profile and region are needed — check `$AWS_PROFILE` or ask the user, and determine the region from the MCP config or `deploy.sh`:

```bash
aws logs describe-log-groups --region <region> --output json \
    --query 'logGroups[?contains(logGroupName, `ControlPlaneLogGroup`) || contains(logGroupName, `DataPlaneLogGroup`)].logGroupName'
```

Store both log group names — they are needed for diagnosing any issues in Phase 7.

---

## Phase 2: Understand the User's Goal

Ask the user:
> "What would you like to do? The recommended first step is a full end-to-end validation using the loopback self-test — this creates a data offering on your connector and then consumes it from the same connector, verifying the entire flow.
>
> 1. **End-to-end validation with S3 (recommended)** — Uploads test data to S3, registers it as an asset, and validates the full AWS-native data path including S3 proxy, IAM roles, and token signing
> 2. **Quick validation with HttpData** — Lighter self-test using an external HTTP endpoint as the data source (skips S3)
> 3. **Create a data offering** — Register an asset, define access policies, and publish a contract offer so other connectors can discover and consume your data
> 4. **Consume data from another connector** — Browse a provider's catalog, negotiate a contract, and transfer data
>
> Press Enter for the recommended S3 end-to-end validation, or choose another option."

If the user picks option 1 or presses Enter, proceed to Phase 5 (Self-Test with S3 Loopback).
If option 2, proceed to Phase 6 (Quick Validation with HttpData).
Otherwise, proceed to the relevant phase based on their answer.

---

## Phase 3: Create a Data Offering (Provider Side)

Walk the user through creating a complete data offering. Ask for details or use sensible defaults.

### Step 3.1: Define a Policy

Ask the user:
> "What access policy should govern your data? Common options:
> - **Open access** — Anyone can use the data (good for testing)
> - **BPN-restricted** — Only specific business partners can access it
>
> For validation, open access is simplest. Want to go with that?"

For open access:
```python
create_policy_definition(
    policy_id="<user-chosen-id-or-default>",
    policy={
        "@context": "http://www.w3.org/ns/odrl.jsonld",
        "@type": "Set",
        "permission": [{"action": "use"}]
    }
)
```

For BPN-restricted access, ask for the allowed BPNLs and construct an appropriate ODRL constraint.

### Step 3.2: Create an Asset

Ask the user what type of data source they want to use:

#### Option A: Amazon S3 data source

The user needs to provide:
- Asset ID and name
- S3 bucket name, object key, and region

```python
create_asset(
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
        "keyName": "<object-key>"
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

Link the asset to the policy:

```python
create_contract_definition(
    contract_definition_id="<user-chosen-id>",
    access_policy_id="<policy-id-from-step-3.1>",
    contract_policy_id="<policy-id-from-step-3.1>",
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
> "What's the DSP endpoint of the provider connector you want to browse? (e.g., `https://<api-id>.execute-api.<region>.amazonaws.com/dsp`)
> And what's their participant ID (BPNL)?"

```python
request_catalog(
    counter_party_address="<provider-dsp-endpoint>",
    counter_party_id="<provider-bpnl>"
)
```

Help the user interpret the catalog response:
- Each `dcat:dataset` entry is an available asset
- The `odrl:hasPolicy` contains the offer details needed for negotiation
- Point out the offer ID (`@id` of the policy), asset ID, and the permission/prohibition/obligation arrays

### Step 4.2: Negotiate a Contract

Using the catalog response, extract the offer details and negotiate:

```python
initiate_contract_negotiation(
    counter_party_address="<provider-dsp-endpoint>",
    offer_id="<@id from odrl:hasPolicy>",
    asset_id="<asset-id from catalog>",
    assigner="<provider-bpnl>",
    permission=<permission array from offer>,
    prohibition=<prohibition array from offer>,
    obligation=<obligation array from offer>
)
```

IMPORTANT: The `permission`, `prohibition`, and `obligation` must be passed through exactly as they appear in the catalog offer. Do not construct a minimal stub — the provider will reject it with "Policy not equal to offer".

### Step 4.3: Wait for Negotiation to Complete

Poll the negotiation state:
```python
get_negotiation_state(negotiation_id="<negotiation-id>")
```

Expected state progression: `REQUESTED` → `AGREED` → `VERIFIED` → `FINALIZED`

If the state is `TERMINATED`, check the error. Common causes:
- Policy mismatch (didn't pass full policy from catalog)
- Provider-side policy evaluation failure (BPN not allowed)

Once `FINALIZED`, retrieve the full negotiation details to get the `contractAgreementId`. The `get_negotiation_state` call only returns the state — you need to query the negotiation to get the agreement ID:

```python
query_contract_negotiations(filter_expression=[{
    "operandLeft": "id",
    "operator": "=",
    "operandRight": "<negotiation-id>"
}])
```

Extract the `contractAgreementId` field from the response.

### Step 4.4: Retrieve the Agreement

```python
get_contract_agreement(agreement_id="<contract-agreement-id>")
```

### Step 4.5: Transfer Data

```python
initiate_transfer(
    counter_party_address="<provider-dsp-endpoint>",
    contract_id="<agreement-id>",
    transfer_type="HttpData-PULL"
)
```

For `HttpData-PULL`, the MCP server automatically sets the data destination to `{"type": "HttpProxy"}`.

### Step 4.6: Get the Data

Poll until the transfer reaches `STARTED`:
```python
get_transfer_state(transfer_process_id="<transfer-id>")
```

If the transfer state is `TERMINATED` instead of progressing to `STARTED`, do NOT retry blindly. Follow the troubleshooting procedure in Phase 8 to diagnose the root cause.

Then retrieve the endpoint data reference:
```python
get_edr_data_address(transfer_process_id="<transfer-id>")
```

The EDR contains:
- `endpoint` — URL to fetch the data from
- `authorization` — Bearer token for authentication

Explain to the user how to use these to fetch the actual data (e.g., via `curl` or any HTTP client).

IMPORTANT: The `endpoint` URL from the EDR is the base URL of the data plane public API. When fetching data, append `public/` to the endpoint path. For example:

```bash
curl -H "Authorization: <authorization-token-from-edr>" "<endpoint>public/"
```

The data plane acts as a proxy — it forwards the request to the provider's actual data source (the `baseUrl` or S3 object configured in the asset's data address) and returns the response. The `Authorization` header contains the EDR token, not AWS credentials — the data plane API does not require IAM auth.

After explaining the curl command, execute it to verify the data is actually flowing. If the response contains the expected data from the asset's data source, the end-to-end flow is validated.

---

## Phase 5: Self-Test with S3 Loopback (Recommended)

This is the recommended validation path. It exercises the full AWS-native data flow: S3 upload → asset registration → catalog → negotiation → transfer → EDR → data plane S3 proxy → consumer HTTP download.

### Step 5.1: Discover Stack Resources

Retrieve the S3 bucket name, DSP endpoint, and BPNL. The bucket name and DSP endpoint come from CloudFormation outputs (they contain CDK-generated suffixes):

```bash
aws cloudformation describe-stacks --stack-name DataspaceConnectorStack --region <region> \
    --query 'Stacks[0].Outputs' --output json
```

Extract:
- `EdcDataPlaneBucketName` → S3 bucket name
- `EdcApiDspApiEndpoint` → DSP endpoint URL

Read the `PARTICIPANT_ID` from `cdk/lib/config/environments.ts` (the `edc.participant.id` field in the `edcIam` object) for the BPNL.

If the user already has these values from a prior deployment, use them directly.

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

Create a policy, asset, and contract definition for the test data:

**Policy:**
```python
create_policy_definition(
    policy_id="test-s3-policy",
    policy={
        "@context": "http://www.w3.org/ns/odrl.jsonld",
        "@type": "Set",
        "permission": [{"action": "use"}]
    }
)
```

**Asset with S3 data address:**
```python
create_asset(
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
        "keyName": "test/sample-data.json"
    }
)
```

**Contract definition:**
```python
create_contract_definition(
    contract_definition_id="test-s3-contract-def",
    access_policy_id="test-s3-policy",
    contract_policy_id="test-s3-policy",
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
    counter_party_address="<own-dsp-endpoint>",
    counter_party_id="<own-bpnl>"
)
```

Locate the `test-s3-asset` entry in the catalog response and extract the offer details.

### Step 5.5: Complete the Consumer Flow

Follow Phase 4 steps 4.2 through 4.6 using the user's own connector as both provider and consumer, targeting the `test-s3-asset` offer from the catalog.

### Step 5.6: Verify the Payload

After the curl returns the data, verify it matches the document uploaded in Step 5.2. The response should be:
```json
{"id":"test-001","name":"Sample Record","description":"Test data for validating the dataspace connector S3 data exchange.","value":42,"timestamp":"2025-01-01T00:00:00Z"}
```

After successful completion:
> "Your connector is fully operational — the complete S3 data exchange flow has been validated end-to-end. Data was uploaded to S3, registered as an asset, discovered via catalog, negotiated, transferred, and retrieved through the data plane proxy. The data plane successfully read from S3 using its IAM role and proxied the content to the consumer over HTTP. You're ready to start sharing data with other Catena-X participants."

---

## Phase 6: Quick Validation with HttpData Loopback

This is a lighter alternative to the S3 self-test. It uses an external HTTP endpoint as the data source, which validates the core EDC flow (catalog, negotiation, transfer, EDR, proxy) but does not exercise the S3 data plane extension or IAM roles.

### Step 6.1: Create a Test Offering

Use Phase 3 with these defaults (or let the user customize):
- Policy ID: `test-policy`
- Asset ID: `test-asset`
- Asset name: "Test Dataset"
- Data source: `https://jsonplaceholder.typicode.com/posts`
- Content type: `application/json`
- Contract definition ID: `test-contract-def`

### Step 6.2: Browse Own Catalog

Retrieve the DSP endpoint and BPNL as described in Phase 5 Step 5.1, then:

```python
request_catalog(
    counter_party_address="<own-dsp-endpoint>",
    counter_party_id="<own-bpnl>"
)
```

### Step 6.3: Complete the Flow

Follow Phase 4 steps 4.2 through 4.6 using the user's own connector as both provider and consumer.

After successful completion:
> "Your connector's core data exchange flow is working — catalog, negotiation, transfer, and HTTP proxy are all operational. For a more thorough validation that includes S3 data sources, run the S3 self-test (option 1)."

---

## Phase 7: Inspect and Clean Up

After testing, help the user review what was created:

```python
query_assets(limit=50)
query_contract_negotiations(limit=50)
query_contract_agreements(limit=50)
query_transfer_processes(limit=50)
```

Note: The EDC Management API does not provide delete operations for assets, policies, or contract definitions through the standard endpoints used by this MCP server. Resources created during testing will persist, including any S3 test objects uploaded during the S3 self-test — do not delete them independently, as that would leave broken asset records. For a clean slate, the user can redeploy the stack (DynamoDB tables are set to `DESTROY` removal policy by default).

---

## Phase 8: Troubleshooting

When any EDC operation reaches an unexpected state (e.g., transfer `TERMINATED` instead of `STARTED`, negotiation `TERMINATED` instead of `FINALIZED`), follow this systematic approach. Do NOT retry or restart services without first collecting and interpreting logs.

### Step 8.1: Query the Failed Process for Error Details

For a failed transfer, query the provider-side transfer process. The consumer transfer has a `correlationId` that maps to the provider's transfer process ID:

```python
query_transfer_processes(filter_expression=[{
    "operandLeft": "id",
    "operator": "=",
    "operandRight": "<consumer-transfer-id>"
}])
```

Extract the `correlationId`, then query the provider side:

```python
query_transfer_processes(filter_expression=[{
    "operandLeft": "id",
    "operator": "=",
    "operandRight": "<correlationId>"
}])
```

The provider-side response contains the `errorDetail` field with the actual error message. The consumer side typically does not include error details.

For a failed negotiation, query similarly:
```python
query_contract_negotiations(filter_expression=[{
    "operandLeft": "id",
    "operator": "=",
    "operandRight": "<negotiation-id>"
}])
```

### Step 8.2: Discover CloudWatch Log Groups

The control plane and data plane each write to their own CloudWatch log group. The names include CDK-generated suffixes, so discover them first:

```bash
aws logs describe-log-groups --region <region> --output json \
    --query 'logGroups[?contains(logGroupName, `ControlPlaneLogGroup`) || contains(logGroupName, `DataPlaneLogGroup`)].logGroupName'
```

This returns two log group names like:
- `DataspaceConnectorStack-ControlPlaneLogGroup<suffix>`
- `DataspaceConnectorStack-DataPlaneLogGroup<suffix>`

Store both — you'll need them for log queries.

### Step 8.3: Pull Time-Correlated Logs from Both Services

Using the timestamp from the failed process (the `stateTimestamp` field from Step 8.1), pull logs from BOTH the control plane and data plane in a window around that time. Always check both services — the root cause may be on either side.

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
| `Policy not equal to offer` | Contract negotiation used a policy that doesn't match the catalog offer | Control plane logs for policy evaluation; verify `permission`/`prohibition`/`obligation` arrays match the catalog exactly |
| `Contract agreement not found` | Invalid or expired contract agreement ID used for transfer | Control plane logs; verify the agreement ID exists via `get_contract_agreement` |
| `Failed to decode token` | Token signing key mismatch between control plane and data plane | Verify both planes have `edc.transfer.proxy.token.signer.privatekey.alias` and `edc.transfer.proxy.token.verifier.publickey.alias` set to the same Secrets Manager key names |
| S3 `AccessDenied` | Data plane Fargate task role lacks `s3:GetObject` permission on the bucket | Check the task role policies; verify the bucket ARN matches |
| No logs in data plane | Data plane task may have crashed or not started | Check ECS service status: `aws ecs describe-services --cluster <cluster> --services <service>` |

IMPORTANT: Always collect logs from BOTH services before drawing conclusions. Do not restart services or retry operations without understanding the root cause first.
