# Prototype Data Exchange Workflow

This steering file guides the agent through prototyping data exchange scenarios using a deployed Dataspace Connector. The connector must already be deployed and MCP tools connected (see the **deploy-connector** steering file).

This workflow helps users rapidly experiment with EDC concepts: creating data offerings, browsing catalogs, negotiating contracts, and transferring data.

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
> "What would you like to prototype? Here are some common scenarios:
>
> 1. **Create a data offering** — Register an asset, define access policies, and publish a contract offer so other connectors can discover and consume your data
> 2. **Consume data from another connector** — Browse a provider's catalog, negotiate a contract, and transfer data
> 3. **Self-test with loopback** — Create an offering on your own connector, then consume it from the same connector (useful for validating your setup end-to-end)
>
> Which scenario interests you, or describe your own?"

Proceed to the relevant phase based on their answer.

---

## Phase 3: Create a Data Offering (Provider Side)

Walk the user through creating a complete data offering. Ask for details or use sensible defaults.

### Step 3.1: Define a Policy

Ask the user:
> "What access policy should govern your data? Common options:
> - **Open access** — Anyone can use the data (good for prototyping)
> - **BPN-restricted** — Only specific business partners can access it
>
> For prototyping, open access is simplest. Want to go with that?"

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

Ask the user:
> "What data do you want to share? I need:
> - A short name/ID for the asset
> - A description
> - The data source URL (where the actual data lives)
> - The content type (e.g., `application/json`, `text/csv`)"

If the user doesn't have a real data source, suggest a placeholder:
> "For prototyping, we can use a public test endpoint like `https://jsonplaceholder.typicode.com/posts` as the data source."

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

If the transfer state is `TERMINATED` instead of progressing to `STARTED`, do NOT retry blindly. Follow the troubleshooting procedure in Phase 7 to diagnose the root cause.

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

The data plane acts as a proxy — it forwards the request to the provider's actual data source (the `baseUrl` configured in the asset's data address) and returns the response. The `Authorization` header contains the EDR token, not AWS credentials — the data plane API does not require IAM auth.

After explaining the curl command, execute it to verify the data is actually flowing. If the response contains the expected data from the asset's data source, the end-to-end flow is validated.

---

## Phase 5: Self-Test with Loopback

This combines Phase 3 and Phase 4 against the user's own connector. Useful for validating the full setup.

### Step 5.1: Create a Test Offering

Use Phase 3 with these defaults (or let the user customize):
- Policy ID: `test-policy`
- Asset ID: `test-asset`
- Asset name: "Test Dataset"
- Data source: `https://jsonplaceholder.typicode.com/posts`
- Content type: `application/json`
- Contract definition ID: `test-contract-def`

### Step 5.2: Browse Own Catalog

To browse your own connector's catalog, you need the DSP endpoint and BPNL. These can be retrieved independently:

**DSP endpoint** — query the CloudFormation stack outputs:
```bash
aws cloudformation describe-stacks --stack-name DataspaceConnectorStack --region <region> --query 'Stacks[0].Outputs[?OutputKey==`EdcApiDspApiEndpointDC133D20`].OutputValue' --output text
```

**BPNL** — read the `PARTICIPANT_ID` from `cdk/lib/config/environments.ts` (the `edc.participant.id` field in the `edcIam` object).

If the user already has these values from a prior deployment, use them directly.

```python
request_catalog(
    counter_party_address="<own-dsp-endpoint>",
    counter_party_id="<own-bpnl>"
)
```

### Step 5.3: Complete the Flow

Follow Phase 4 steps 4.2 through 4.6 using the user's own connector as both provider and consumer.

After successful completion:
> "Your connector is fully operational — you've validated the complete data exchange flow end-to-end. You're ready to start sharing data with other Catena-X participants."

---

## Phase 6: Inspect and Clean Up

After prototyping, help the user review what was created:

```python
query_assets(limit=50)
query_contract_negotiations(limit=50)
query_contract_agreements(limit=50)
query_transfer_processes(limit=50)
```

Note: The EDC Management API does not provide delete operations for assets, policies, or contract definitions through the standard endpoints used by this MCP server. Resources created during prototyping will persist. For a clean slate, the user can redeploy the stack (DynamoDB tables are set to `DESTROY` removal policy by default).

---

## Phase 7: Troubleshooting

When any EDC operation reaches an unexpected state (e.g., transfer `TERMINATED` instead of `STARTED`, negotiation `TERMINATED` instead of `FINALIZED`), follow this systematic approach. Do NOT retry or restart services without first collecting and interpreting logs.

### Step 7.1: Query the Failed Process for Error Details

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

### Step 7.2: Discover CloudWatch Log Groups

The control plane and data plane each write to their own CloudWatch log group. The names include CDK-generated suffixes, so discover them first:

```bash
aws logs describe-log-groups --region <region> --output json \
    --query 'logGroups[?contains(logGroupName, `ControlPlaneLogGroup`) || contains(logGroupName, `DataPlaneLogGroup`)].logGroupName'
```

This returns two log group names like:
- `DataspaceConnectorStack-ControlPlaneLogGroup<suffix>`
- `DataspaceConnectorStack-DataPlaneLogGroup<suffix>`

Store both — you'll need them for log queries.

### Step 7.3: Pull Time-Correlated Logs from Both Services

Using the timestamp from the failed process (the `stateTimestamp` field from Step 7.1), pull logs from BOTH the control plane and data plane in a window around that time. Always check both services — the root cause may be on either side.

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

### Step 7.4: Interpret and Act

With the error detail from Step 7.1 and the correlated logs from Step 7.3, interpret the root cause before taking action. Common patterns:

| Error Detail | Likely Cause | Where to Look |
|---|---|---|
| `DataPlane not found` | Data plane registration expired or data plane not running | Control plane logs for `DataPlaneSelectorManagerImpl` state changes; data plane logs for `DataPlaneHealthCheck` registration |
| `Policy not equal to offer` | Contract negotiation used a policy that doesn't match the catalog offer | Control plane logs for policy evaluation; verify `permission`/`prohibition`/`obligation` arrays match the catalog exactly |
| `Contract agreement not found` | Invalid or expired contract agreement ID used for transfer | Control plane logs; verify the agreement ID exists via `get_contract_agreement` |
| No logs in data plane | Data plane task may have crashed or not started | Check ECS service status: `aws ecs describe-services --cluster <cluster> --services <service>` |

IMPORTANT: Always collect logs from BOTH services before drawing conclusions. Do not restart services or retry operations without understanding the root cause first.
