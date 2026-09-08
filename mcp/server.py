"""
Dataspace Connector MCP Server

Provides general-purpose primitives for interacting with the Eclipse Dataspace
Components (EDC) Management API. The server exposes clean, stable primitives that
map closely to the EDC Management API; workflow orchestration (the consumer and
provider sequences) lives in the consuming skill/agent layer, not here. This keeps
the server workflow-agnostic, so new dataspace use cases need no new server tools.

Supports two modes:
- Legacy (single connector): Set EDC_MANAGEMENT_URL only. All tools target that endpoint directly.
- Multi-connector (Dataspace Connector on AWS): Set EDC_MULTI_CONNECTOR=true.
  Connector IDs and the Management and DSP (protocol) base URLs are discovered from
  CloudFormation, so EDC_MANAGEMENT_URL is optional (used as an override if set).
  Requires connector_id on all tools.

Tools (12):
- list_connectors             Discover deployed connectors + endpoints from CloudFormation
- request_catalog             Request a provider's DCAT catalog over DSP
- query_resources             List/query any control-plane resource collection (enum)
- get_resource                Read one resource by id, incl. edr (enum)
- delete_resource             Delete a deletable resource (assets/policies/contract-defs)
- create_asset                Register a data asset (descriptor + data address)
- create_policy               Create an ODRL policy definition
- create_contract_definition  Link assets to access + contract policies (catalog-visible)
- initiate_negotiation        Start a contract negotiation for a catalog offer
- initiate_transfer           Start a data transfer against an agreement
- manage_transfer             Suspend/resume/complete/terminate a transfer (or all STARTED)
- fetch_data                  Resolve the EDR and fetch the payload from the data plane
"""

import json
import os
from typing import Any, Literal, Optional
import httpx
import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from mcp.server.fastmcp import FastMCP

# Configuration
# EDC_MANAGEMENT_URL is an explicit override. In single-connector mode it is the
# endpoint (falling back to localhost). In multi-connector mode it is optional:
# when unset, the Management and DSP endpoints are discovered from the shared
# infrastructure stack's CloudFormation outputs.
_ENV_MANAGEMENT_URL = os.getenv("EDC_MANAGEMENT_URL")
_DEFAULT_MANAGEMENT_URL = "http://localhost:8080/management"
EDC_API_KEY = os.getenv("EDC_API_KEY", "")
USE_AWS_IAM = os.getenv("EDC_USE_AWS_IAM", "false").lower() == "true"
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
MULTI_CONNECTOR = os.getenv("EDC_MULTI_CONNECTOR", "false").lower() == "true"

# CloudFormation stack naming. Every stack is prefixed by the deployment name
# (DEPLOYMENT_NAME, default "DataspaceConnector"), so a server instance targets
# exactly one deployment even when several share an account and region.
DEPLOYMENT_NAME = os.getenv("DEPLOYMENT_NAME", "DataspaceConnector")
_CFN_STACK_PREFIX = f"{DEPLOYMENT_NAME}-Connector-"
_CFN_SHARED_INFRA_NAME = f"{DEPLOYMENT_NAME}-SharedInfra"

# Cached CloudFormation discovery (connector IDs + endpoint URLs) for multi-connector
# mode, populated once per process. Restart the server to pick up new connectors.
_discovery_cache: Optional[dict[str, Any]] = None

_MULTI_INSTRUCTIONS = (
    "This server manages multiple EDC connectors deployed via Dataspace Connector on AWS. "
    "ALWAYS call list_connectors first to discover connector IDs and the Management/DSP base URLs; "
    "pass connector_id to every other tool. Resource operations are generic: use query_resources "
    "(list), get_resource (read one), and delete_resource (delete) with a resource_type enum. "
    "Typical consumer flow: request_catalog -> initiate_negotiation (pass the offer's "
    "permission/prohibition/obligation through exactly) -> poll get_resource(contract_negotiations) "
    "until FINALIZED -> initiate_transfer -> poll get_resource(transfer_processes) until STARTED -> "
    "fetch_data. Typical provider flow: create_policy (access + usage) -> create_asset -> "
    "create_contract_definition."
)

# EDC JSON-LD contexts. The Catena-X policy profile is required for policy
# definitions and for the offer policy echoed back in a contract negotiation.
_EDC_CONTEXT = {"@vocab": "https://w3id.org/edc/v0.0.1/ns/"}
_POLICY_CONTEXT = [
    "https://w3id.org/dspace/2025/1/odrl-profile.jsonld",
    "https://w3id.org/catenax/2025/9/policy/context.jsonld",
    {"@vocab": "https://w3id.org/edc/v0.0.1/ns/"},
]

# resource_type enum -> EDC Management API path segment.
_RESOURCE_PATH: dict[str, str] = {
    "assets": "assets",
    "policy_definitions": "policydefinitions",
    "contract_definitions": "contractdefinitions",
    "contract_negotiations": "contractnegotiations",
    "contract_agreements": "contractagreements",
    "transfer_processes": "transferprocesses",
}
# Only these resource types support DELETE via the Management API. Negotiations,
# agreements, and transfer processes are not deletable (transfers end via
# manage_transfer(action="terminate")).
_DELETABLE = {"assets", "policy_definitions", "contract_definitions"}

# EDC TransferProcessStates integer code for STARTED. The store persists and
# filters transfer `state` as this integer (not the "STARTED" string label), so
# server-side state filters must use the code. Stable across EDC versions.
_TRANSFER_STATE_STARTED = 600

QueryResourceType = Literal[
    "assets", "policy_definitions", "contract_definitions",
    "contract_negotiations", "contract_agreements", "transfer_processes",
]
GetResourceType = Literal[
    "assets", "policy_definitions", "contract_definitions",
    "contract_negotiations", "contract_agreements", "transfer_processes", "edr",
]
DeleteResourceType = Literal["assets", "policy_definitions", "contract_definitions"]
TransferAction = Literal["suspend", "resume", "complete", "terminate"]

mcp = FastMCP(
    "dataspace-connector",
    instructions=_MULTI_INSTRUCTIONS if MULTI_CONNECTOR else None,
)

_aws_session = None
if USE_AWS_IAM or MULTI_CONNECTOR:
    _aws_session = boto3.Session()


def _resolve_management_url(connector_id: Optional[str]) -> str:
    """Resolve the Management API base URL for a request.

    Single-connector mode: use EDC_MANAGEMENT_URL (falling back to localhost).
    Multi-connector mode: connector_id is prepended as a path segment, and the
    base is the explicit EDC_MANAGEMENT_URL override if set, otherwise the value
    discovered from the shared-infra stack's ManagementApiUrl output.
    """
    if not MULTI_CONNECTOR:
        return (_ENV_MANAGEMENT_URL or _DEFAULT_MANAGEMENT_URL).rstrip("/")

    if not connector_id:
        raise ValueError(
            "connector_id is required in multi-connector mode. "
            "Call list_connectors first to discover available connector IDs."
        )

    base = _norm_url(_ENV_MANAGEMENT_URL) or _discover()["management_url"]
    if not base:
        raise ValueError(
            "Could not resolve the EDC Management API URL. Set EDC_MANAGEMENT_URL, "
            "or ensure the shared-infrastructure stack exports the ManagementApiUrl "
            "output and your credentials allow cloudformation:ListStacks and DescribeStacks."
        )
    return f"{base}/{connector_id}"


def _norm_url(value: Optional[str]) -> Optional[str]:
    """Normalize a URL to a bare base with no trailing slash."""
    return value.rstrip("/") if value else None


def _discover() -> dict[str, Any]:
    """Discover connector IDs and Management/DSP base URLs from CloudFormation.

    One list_stacks pass (connector IDs + shared-infra stack) plus one
    describe_stacks (endpoint outputs), cached for the process lifetime. Restart
    the server to pick up newly deployed connectors or changed endpoints.
    """
    global _discovery_cache
    if _discovery_cache is not None:
        return _discovery_cache

    cfn = _aws_session.client("cloudformation", region_name=AWS_REGION)
    connector_ids: list[str] = []
    shared_infra: Optional[str] = None
    for page in cfn.get_paginator("list_stacks").paginate(
        StackStatusFilter=["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]
    ):
        for stack in page.get("StackSummaries", []):
            name = stack["StackName"]
            if name == _CFN_SHARED_INFRA_NAME:
                shared_infra = name
            elif name.startswith(_CFN_STACK_PREFIX):
                connector_ids.append(name[len(_CFN_STACK_PREFIX) :])
    connector_ids.sort()

    management_url = dsp_url = None
    if shared_infra:
        stacks = cfn.describe_stacks(StackName=shared_infra).get("Stacks", [])
        outputs = stacks[0].get("Outputs", []) if stacks else []
        by_key = {o["OutputKey"]: o.get("OutputValue") for o in outputs}
        management_url = _norm_url(by_key.get("ManagementApiUrl"))
        dsp_url = _norm_url(by_key.get("DspApiUrl"))

    _discovery_cache = {
        "connector_ids": connector_ids,
        "management_url": management_url,
        "dsp_url": dsp_url,
    }
    return _discovery_cache


def get_headers() -> dict[str, str]:
    """Get HTTP headers for API requests."""
    headers = {
        "Content-Type": "application/json",
    }
    if EDC_API_KEY:
        headers["X-Api-Key"] = EDC_API_KEY
    return headers


def sign_request(method: str, url: str, headers: dict[str, str], body: bytes = None) -> dict[str, str]:
    """Sign request with AWS SigV4 if enabled."""
    if not USE_AWS_IAM:
        return headers

    # Fetch fresh credentials each call so temporary-credential expiry is handled.
    credentials = _aws_session.get_credentials()
    frozen_credentials = credentials.get_frozen_credentials()

    if body and "Content-Type" not in headers:
        headers["Content-Type"] = "application/json"

    aws_request = AWSRequest(method=method, url=url, data=body, headers=headers)
    SigV4Auth(frozen_credentials, "execute-api", AWS_REGION).add_auth(aws_request)
    return dict(aws_request.headers)


def _status_hint(status: int, body: Any) -> Optional[str]:
    """Map an HTTP error status to an actionable hint for the agent."""
    if status == 404:
        return (
            "Resource not found. Verify the id and (in multi-connector mode) the connector_id. "
            "For a just-created resource, allow a moment before reading it back."
        )
    if status == 409:
        return (
            "Conflict. The resource is likely still referenced by another resource "
            "(for example, an asset referenced by a finalized contract agreement cannot be "
            "deleted until the agreement is gone)."
        )
    if status == 400:
        text = str(body).lower()
        if "policy" in text and ("equal" in text or "offer" in text):
            return (
                "Policy mismatch. Pass the catalog offer's permission/prohibition/obligation "
                "through to initiate_negotiation exactly as returned by request_catalog; do not "
                "send an empty or modified policy."
            )
        return (
            "Bad request. Check the payload. For a transfer lifecycle action, the transfer may "
            "not be in a valid state for this action (e.g. resuming a transfer that is not SUSPENDED)."
        )
    if status in (401, 403):
        return (
            "Not authorized. Verify AWS credentials and execute-api:Invoke permission. For fetch_data, "
            "a 403 usually means the wrong sub-path (the public API is at '<endpoint>/public/') or an "
            "expired EDR token."
        )
    return None


async def _api_request(
    method: str, path: str, payload: dict | None = None, connector_id: Optional[str] = None
) -> Any:
    """Make an authenticated request to the EDC Management API.

    Returns parsed JSON on success (dict or list). For 204/empty successful
    responses (suspend/resume/complete/terminate, delete) returns a structured
    {"success": True, "status": ...}. On failure returns a structured error with
    a status code, the raw message, and an actionable hint. Never raises a parse
    error back to the caller.
    """
    base_url = _resolve_management_url(connector_id)
    url = f"{base_url}{path}"
    headers = get_headers()
    body = json.dumps(payload).encode("utf-8") if payload else None

    signed_headers = sign_request(method, url, headers, body)

    async with httpx.AsyncClient() as client:
        response = await client.request(
            method,
            url,
            content=body,
            headers=signed_headers,
            timeout=30.0,
        )

    if not response.is_success:
        try:
            error_body = response.json()
        except Exception:
            error_body = response.text
        return {
            "error": True,
            "status": response.status_code,
            "message": error_body,
            "path": path,
            "method": method,
            "hint": _status_hint(response.status_code, error_body),
        }

    # EDC returns 204 No Content for lifecycle actions and deletes; also guard
    # any empty or non-JSON success body so callers never see a parse error.
    if response.status_code == 204 or not response.content:
        return {"success": True, "status": response.status_code}
    try:
        return response.json()
    except Exception:
        return {"success": True, "status": response.status_code, "body": response.text}


def _build_query_spec(
    offset: int,
    limit: int,
    filter_expression: Optional[list[dict[str, Any]]],
    sort_field: Optional[str],
    sort_order: str,
) -> dict[str, Any]:
    """Build an EDC QuerySpec body for POST /v3/{resource}/request."""
    spec: dict[str, Any] = {
        "@context": _EDC_CONTEXT,
        "@type": "QuerySpec",
        "offset": offset,
        "limit": limit,
    }
    if filter_expression:
        spec["filterExpression"] = filter_expression
    if sort_field:
        spec["sortField"] = sort_field
        spec["sortOrder"] = sort_order
    return spec


def _contract_request_payload(
    counter_party_address: str,
    offer_id: str,
    asset_id: str,
    assigner: str,
    protocol: str,
    permission: Optional[list[dict[str, Any]]],
    prohibition: Optional[list[dict[str, Any]]],
    obligation: Optional[list[dict[str, Any]]],
    callback_addresses: Optional[list[dict[str, Any]]],
) -> dict[str, Any]:
    """Build the ContractRequest payload for a contract negotiation.

    The policy MUST echo the catalog offer: same @id, assigner, target, and the
    permission/prohibition/obligation arrays passed through exactly. A mismatch
    causes the provider to reject the negotiation ("Policy not equal to offer").
    """
    policy: dict[str, Any] = {
        "@type": "odrl:Offer",
        "@id": offer_id,
        "assigner": assigner,
        "target": asset_id,
    }
    if permission is not None:
        policy["odrl:permission"] = permission
    if prohibition is not None:
        policy["odrl:prohibition"] = prohibition
    if obligation is not None:
        policy["odrl:obligation"] = obligation

    payload: dict[str, Any] = {
        "@context": _POLICY_CONTEXT,
        "@type": "ContractRequest",
        "counterPartyAddress": counter_party_address,
        "protocol": protocol,
        "policy": policy,
    }
    if callback_addresses:
        payload["callbackAddresses"] = callback_addresses
    return payload


# ─── Discovery ─────────────────────────────────────────────────────────────────


@mcp.tool()
async def list_connectors() -> dict[str, Any]:
    """
    Discover deployed EDC connectors and endpoints from CloudFormation.

    When to use: FIRST, before any other tool in multi-connector mode. It returns
    the connector IDs to pass as connector_id, and the base URLs used to build a
    counterparty's DSP address ("{dsp_base_url}/{connector_id}").

    Returns: {connector_ids[], count, management_base_url, dsp_base_url (null if
    unavailable), region}. Both base URLs include the https:// scheme and no
    trailing slash.

    Requires EDC_MULTI_CONNECTOR=true and cloudformation:ListStacks plus
    cloudformation:DescribeStacks IAM permissions. Results are cached per process;
    restart the server to pick up newly deployed connectors.
    """
    if not MULTI_CONNECTOR:
        return {
            "error": True,
            "message": (
                "Multi-connector discovery is not enabled. "
                "Set EDC_MULTI_CONNECTOR=true for Dataspace Connector on AWS deployments. "
                "In single-connector mode, all tools target EDC_MANAGEMENT_URL directly."
            ),
        }

    try:
        discovery = _discover()
        management_base_url = _norm_url(_ENV_MANAGEMENT_URL) or discovery["management_url"]
        return {
            "connector_ids": discovery["connector_ids"],
            "count": len(discovery["connector_ids"]),
            "management_base_url": management_base_url,
            "dsp_base_url": discovery["dsp_url"],
            "region": AWS_REGION,
        }

    except Exception as e:
        return {
            "error": True,
            "message": f"Failed to discover connectors from CloudFormation: {str(e)}",
            "hint": (
                "Ensure your AWS credentials have cloudformation:ListStacks and "
                "cloudformation:DescribeStacks permissions."
            ),
        }


# ─── Generic resource primitives (list / get / delete) ──────────────────────────


@mcp.tool()
async def query_resources(
    resource_type: QueryResourceType,
    filter_expression: Optional[list[dict[str, Any]]] = None,
    limit: int = 50,
    offset: int = 0,
    sort_field: Optional[str] = None,
    sort_order: str = "ASC",
    connector_id: Optional[str] = None,
) -> Any:
    """
    List/query any control-plane resource collection on a connector.

    When to use: to enumerate or search a resource type. This is the single LIST
    primitive; it maps resource_type to POST /v3/{resource}/request.

    resource_type: one of assets | policy_definitions | contract_definitions |
    contract_negotiations | contract_agreements | transfer_processes.

    filter_expression: optional list of {operandLeft, operator, operandRight}
    criteria. Two gotchas: asset queries use expanded JSON-LD property names; and
    the transfer/negotiation `state` field is an EDC integer state code (for
    example 600=STARTED, 850=TERMINATED), so filter by the numeric code passed as a
    number, not the string label "STARTED" (manage_transfer's "all_started" filters
    by state=600 this way).

    Returns: an array of resource objects for the requested type.
    """
    path = _RESOURCE_PATH.get(resource_type)
    if not path:
        return {"error": True, "message": f"Unknown resource_type '{resource_type}'."}
    spec = _build_query_spec(offset, limit, filter_expression, sort_field, sort_order)
    return await _api_request("POST", f"/v3/{path}/request", spec, connector_id=connector_id)


@mcp.tool()
async def get_resource(
    resource_type: GetResourceType,
    resource_id: str,
    connector_id: Optional[str] = None,
) -> Any:
    """
    Read a single resource by id.

    When to use: to inspect one resource, and most commonly to poll a
    negotiation or transfer to completion.

    resource_type: assets | policy_definitions | contract_definitions |
    contract_negotiations | contract_agreements | transfer_processes | edr.
    For "edr", resource_id is the transfer_process_id and this returns the raw
    endpoint data reference (endpoint URL, authorization token, refresh info) for
    inspection; use fetch_data to actually retrieve the payload.

    Polling guidance (the object carries a "state" field):
    - contract_negotiations: INITIAL -> REQUESTED -> AGREED -> VERIFIED ->
      FINALIZED (read contractAgreementId when FINALIZED), or TERMINATED (see
      errorDetail).
    - transfer_processes: REQUESTED -> STARTED -> (SUSPENDED <-> RESUMED) ->
      COMPLETED / TERMINATED; internal PROVISIONED/DEPROVISIONED.

    Returns: the full resource object (for edr, the data address).
    """
    if resource_type == "edr":
        return await _api_request(
            "GET", f"/v3/edrs/{resource_id}/dataaddress", connector_id=connector_id
        )
    path = _RESOURCE_PATH.get(resource_type)
    if not path:
        return {"error": True, "message": f"Unknown resource_type '{resource_type}'."}
    return await _api_request("GET", f"/v3/{path}/{resource_id}", connector_id=connector_id)


@mcp.tool()
async def delete_resource(
    resource_type: DeleteResourceType,
    resource_id: str,
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Delete a resource by id.

    When to use: test/demo cleanup, or removing an obsolete offering. Only
    assets, policy_definitions, and contract_definitions are deletable via the
    Management API. Negotiations and agreements are immutable; end a transfer with
    manage_transfer(action="terminate") instead.

    Note: an asset referenced by a finalized contract agreement returns 409 and
    cannot be deleted until the agreement is gone.

    Returns: {success, resource_type, resource_id, status} on success, or a
    structured error with a hint.
    """
    if resource_type not in _DELETABLE:
        return {
            "error": True,
            "message": (
                f"'{resource_type}' cannot be deleted via the Management API. "
                "Deletable: assets, policy_definitions, contract_definitions. "
                "End a transfer with manage_transfer(action='terminate')."
            ),
        }
    path = _RESOURCE_PATH[resource_type]
    resp = await _api_request("DELETE", f"/v3/{path}/{resource_id}", connector_id=connector_id)
    if isinstance(resp, dict) and resp.get("error"):
        return resp
    return {
        "success": True,
        "resource_type": resource_type,
        "resource_id": resource_id,
        "status": resp.get("status", 200) if isinstance(resp, dict) else 200,
    }


# ─── Provider primitives ─────────────────────────────────────────────────────────


@mcp.tool()
async def create_asset(
    asset_id: str,
    properties: dict[str, Any],
    data_address: dict[str, Any],
    private_properties: Optional[dict[str, Any]] = None,
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Register a data asset (descriptor + data address).

    When to use: provider side, to publish a data resource. properties is public
    metadata (name, contentType, and arbitrary custom props such as dct:type or
    cx-common:version). data_address describes how the data plane reads the source
    (e.g. {"type":"AmazonS3","region":...,"bucketName":...,"objectName":...} or
    {"type":"HttpData","baseUrl":...}).

    Returns: {@id, createdAt}.
    """
    payload = {
        "@context": {
            "@vocab": "https://w3id.org/edc/v0.0.1/ns/",
            "dct": "http://purl.org/dc/terms/",
        },
        "@id": asset_id,
        "@type": "Asset",
        "properties": properties,
        "dataAddress": {
            "@type": "DataAddress",
            **data_address,
        },
    }
    if private_properties:
        payload["privateProperties"] = private_properties

    return await _api_request("POST", "/v3/assets", payload, connector_id=connector_id)


@mcp.tool()
async def create_policy(
    policy_id: str,
    policy: dict[str, Any],
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Create an ODRL policy definition.

    When to use: provider side, to define an access policy (who can see the offer)
    or a usage/contract policy (who can negotiate). Kept standalone because
    policies are legitimately reused across offerings.

    The Catena-X policy context is added automatically. Example usage policy body:
    {"@type":"Set","permission":[{"action":"use","constraint":[{"and":[
      {"leftOperand":"FrameworkAgreement","operator":"eq","rightOperand":"DataExchangeGovernance:1.0"},
      {"leftOperand":"UsagePurpose","operator":"isAnyOf","rightOperand":"cx.core.industrycore:1"}]}]}]}
    Example access policy: constraint {"leftOperand":"Membership","operator":"eq","rightOperand":"active"}.

    Returns: {@id, createdAt}.
    """
    payload = {
        "@context": _POLICY_CONTEXT,
        "@id": policy_id,
        "@type": "PolicyDefinition",
        "policy": policy,
    }
    return await _api_request("POST", "/v3/policydefinitions", payload, connector_id=connector_id)


@mcp.tool()
async def create_contract_definition(
    contract_definition_id: str,
    access_policy_id: str,
    contract_policy_id: str,
    assets_selector: list[dict[str, Any]],
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Link assets to access + contract policies, making them catalog-visible.

    When to use: provider side, after creating the asset and both policies. The
    access policy controls catalog visibility; the contract policy governs usage.
    assets_selector is a list of criteria, e.g.
    [{"operandLeft":"https://w3id.org/edc/v0.0.1/ns/id","operator":"=","operandRight":"<asset-id>"}].

    Returns: {@id, createdAt}.
    """
    payload = {
        "@context": _EDC_CONTEXT,
        "@id": contract_definition_id,
        "@type": "ContractDefinition",
        "accessPolicyId": access_policy_id,
        "contractPolicyId": contract_policy_id,
        "assetsSelector": assets_selector,
    }
    return await _api_request("POST", "/v3/contractdefinitions", payload, connector_id=connector_id)


# ─── Consumer primitives ─────────────────────────────────────────────────────────


@mcp.tool()
async def request_catalog(
    counter_party_address: str,
    counter_party_id: str,
    protocol: str = "dataspace-protocol-http",
    query_spec: Optional[dict[str, Any]] = None,
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Request a provider's DCAT catalog over DSP.

    When to use: consumer side, to discover available datasets and their offers.
    counter_party_address is the provider's DSP endpoint ("{dsp_base_url}/{provider_id}");
    counter_party_id is the provider BPNL. Pass query_spec to filter/paginate a
    large catalog.

    Returns: DCAT catalog JSON-LD. Each dcat:dataset carries an odrl:hasPolicy
    offer; capture its @id (offer_id), the assigner (provider BPNL), and the
    permission/prohibition/obligation arrays to pass, unchanged, to
    initiate_negotiation.
    """
    payload = {
        "@context": [_EDC_CONTEXT],
        "@type": "CatalogRequest",
        "counterPartyAddress": counter_party_address,
        "counterPartyId": counter_party_id,
        "protocol": protocol,
    }
    if query_spec:
        payload["querySpec"] = query_spec

    return await _api_request("POST", "/v3/catalog/request", payload, connector_id=connector_id)


@mcp.tool()
async def initiate_negotiation(
    counter_party_address: str,
    offer_id: str,
    asset_id: str,
    assigner: str,
    protocol: str = "dataspace-protocol-http",
    permission: Optional[list[dict[str, Any]]] = None,
    prohibition: Optional[list[dict[str, Any]]] = None,
    obligation: Optional[list[dict[str, Any]]] = None,
    callback_addresses: Optional[list[dict[str, Any]]] = None,
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Initiate a contract negotiation for a catalog offer.

    When to use: consumer side, after request_catalog. offer_id is the @id of the
    catalog offer (odrl:hasPolicy), asset_id is the dataset id, assigner is the
    provider BPNL.

    CRITICAL: permission, prohibition, and obligation MUST be passed through
    exactly as they appear in the catalog offer. Sending an empty or altered
    policy causes the provider to reject the negotiation with TERMINATED /
    "Policy not equal to offer".

    Returns: {@id} (negotiation id). Then poll
    get_resource(resource_type="contract_negotiations", resource_id=<id>):
    INITIAL -> REQUESTED -> AGREED -> VERIFIED -> FINALIZED (read
    contractAgreementId when FINALIZED), or TERMINATED with errorDetail.
    """
    payload = _contract_request_payload(
        counter_party_address, offer_id, asset_id, assigner, protocol,
        permission, prohibition, obligation, callback_addresses,
    )
    return await _api_request("POST", "/v3/contractnegotiations", payload, connector_id=connector_id)


@mcp.tool()
async def initiate_transfer(
    counter_party_address: str,
    contract_id: str,
    transfer_type: str,
    protocol: str = "dataspace-protocol-http",
    data_destination: Optional[dict[str, Any]] = None,
    callback_addresses: Optional[list[dict[str, Any]]] = None,
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Start a data transfer against a finalized agreement.

    When to use: consumer side, after a negotiation reaches FINALIZED. contract_id
    is the contractAgreementId. For consumer pull use transfer_type="HttpData-PULL"
    and no data_destination (an HttpProxy destination is set automatically); for
    push flows supply data_destination.

    Returns: {@id} (transfer process id). Then poll
    get_resource(resource_type="transfer_processes", resource_id=<id>):
    REQUESTED -> STARTED -> (SUSPENDED <-> RESUMED) -> COMPLETED / TERMINATED.
    Once STARTED, call fetch_data to retrieve the payload.
    """
    payload: dict[str, Any] = {
        "@context": _EDC_CONTEXT,
        "@type": "TransferRequest",
        "counterPartyAddress": counter_party_address,
        "contractId": contract_id,
        "transferType": transfer_type,
        "protocol": protocol,
    }
    if data_destination:
        payload["dataDestination"] = data_destination
    else:
        payload["dataDestination"] = {"@type": "DataAddress", "type": "HttpProxy"}
    if callback_addresses:
        payload["callbackAddresses"] = callback_addresses

    return await _api_request("POST", "/v3/transferprocesses", payload, connector_id=connector_id)


async def _apply_transfer_action(
    transfer_process_id: str,
    action: TransferAction,
    reason: Optional[str],
    connector_id: Optional[str],
) -> dict[str, Any]:
    """Apply one lifecycle action to a single transfer process."""
    payload = None
    if action in ("suspend", "terminate"):
        payload = {"@context": _EDC_CONTEXT, "reason": reason or f"{action} requested via MCP"}
    resp = await _api_request(
        "POST", f"/v3/transferprocesses/{transfer_process_id}/{action}", payload,
        connector_id=connector_id,
    )
    if isinstance(resp, dict) and resp.get("error"):
        # An invalid state transition (400) is non-fatal: the transfer may already
        # be in a terminal state. Report it as skipped rather than a hard failure.
        return {
            "success": False,
            "skipped": resp.get("status") == 400,
            "transfer_process_id": transfer_process_id,
            "action": action,
            "status": resp.get("status"),
            "message": resp.get("message"),
            "hint": resp.get("hint"),
        }
    resulting = {
        "suspend": "SUSPENDING",
        "resume": "RESUMING",
        "complete": "COMPLETING",
        "terminate": "TERMINATING",
    }[action]
    return {
        "success": True,
        "transfer_process_id": transfer_process_id,
        "action": action,
        "resulting_state": resulting,
        "note": (
            "State transitions asynchronously; poll "
            "get_resource(resource_type='transfer_processes', resource_id=...) to confirm."
        ),
    }


@mcp.tool()
async def manage_transfer(
    transfer_process_id: str,
    action: TransferAction,
    reason: Optional[str] = None,
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Perform a lifecycle action on a transfer process.

    When to use: to drive the transfer state machine beyond the pull-and-fetch
    happy path. action is one of:
    - suspend    pause a STARTED transfer (reason recorded)
    - resume     resume a SUSPENDED transfer
    - complete   complete a finite transfer
    - terminate  end a transfer (reason recorded)

    An action that isn't valid from the transfer's current state returns a clear
    non-fatal message rather than raising. EDC returns 204 No Content; this tool
    reports a structured result instead of parsing an empty body.

    Note: suspend/resume support is transfer-type dependent. For HttpData-PULL,
    suspend works (STARTED -> SUSPENDED), but resume may not restore STARTED (the
    transfer can move to TERMINATED); terminate is the reliable action for ending a
    transfer and for cost cleanup.

    Batch cleanup: pass transfer_process_id="all_started" to apply the action to
    every currently STARTED transfer (selected server-side by EDC's STARTED state
    code). This is the recommended way to reap idle provider-side pull transfers,
    which keep consuming DynamoDB on this AWS deployment. Returns a per-id summary.

    Returns (single): {success, transfer_process_id, action, resulting_state}.
    Returns (all_started): {action, batch, total, succeeded[], skipped[], failed[]}.
    """
    if transfer_process_id == "all_started":
        # STARTED transfers are what accrue provider-side DynamoDB cost. Filter
        # server-side by EDC's TransferProcessStates integer code for STARTED (the
        # store compares the numeric state, not the "STARTED" string label).
        spec = _build_query_spec(
            0, 500,
            [{"operandLeft": "state", "operator": "=", "operandRight": _TRANSFER_STATE_STARTED}],
            None, "ASC",
        )
        result = await _api_request(
            "POST", "/v3/transferprocesses/request", spec, connector_id=connector_id
        )
        if isinstance(result, dict) and result.get("error"):
            return result
        started = result if isinstance(result, list) else []
        succeeded: list[str] = []
        skipped: list[dict[str, Any]] = []
        failed: list[dict[str, Any]] = []
        for t in started:
            tid = t.get("@id") or t.get("id")
            r = await _apply_transfer_action(tid, action, reason, connector_id)
            if r.get("success"):
                succeeded.append(tid)
            elif r.get("skipped"):
                skipped.append({"id": tid, "message": r.get("message")})
            else:
                failed.append({"id": tid, "message": r.get("message")})
        return {
            "action": action,
            "batch": "all_started",
            "total": len(started),
            "succeeded": succeeded,
            "skipped": skipped,
            "failed": failed,
        }

    return await _apply_transfer_action(transfer_process_id, action, reason, connector_id)


@mcp.tool()
async def fetch_data(
    transfer_process_id: str,
    method: str = "GET",
    path: Optional[str] = None,
    query_params: Optional[dict[str, Any]] = None,
    body: Optional[dict[str, Any]] = None,
    media_type: Optional[str] = None,
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Resolve the EDR for an active transfer and fetch the payload from the data plane.

    When to use: consumer side, once a transfer is STARTED. This resolves the
    endpoint data reference (endpoint + authorization token) and makes the HTTP
    request to the provider's data plane public API in one step, refreshing the
    token transparently. To inspect the raw EDR without fetching, use
    get_resource(resource_type="edr", resource_id=<transfer_process_id>).

    By default the Tractus-X public sub-path "public/" is appended to the EDR
    endpoint (the standard data plane public API path). Override with an explicit
    path only if the asset needs a different sub-path; query_params/body/method
    support parameterized or proxied sources.

    Returns: {status, headers, body}. body may be a JSON string that the caller
    parses. On 403, the cause is usually the wrong sub-path (the public API is
    at "<endpoint>/public/") or an expired EDR token (re-initiate the transfer and
    fetch again).
    """
    edr = await _api_request(
        "GET", f"/v3/edrs/{transfer_process_id}/dataaddress", connector_id=connector_id
    )
    if isinstance(edr, dict) and edr.get("error"):
        return edr

    endpoint = edr.get("endpoint") or edr.get("https://w3id.org/edc/v0.0.1/ns/endpoint")
    authorization = edr.get("authorization") or edr.get(
        "https://w3id.org/edc/v0.0.1/ns/authorization"
    )
    if not endpoint:
        return {"error": True, "message": "EDR does not contain an endpoint URL", "edr": edr}
    if not authorization:
        return {"error": True, "message": "EDR does not contain an authorization token", "edr": edr}

    sub_path = path if path is not None else "public/"
    target_url = f"{endpoint.rstrip('/')}/{sub_path.lstrip('/')}"

    headers: dict[str, str] = {"Authorization": authorization}
    if body is not None:
        headers["Content-Type"] = media_type or "application/json"
    request_body = json.dumps(body).encode("utf-8") if body is not None else None

    async with httpx.AsyncClient() as client:
        response = await client.request(
            method.upper(),
            target_url,
            content=request_body,
            headers=headers,
            params=query_params,
            timeout=60.0,
        )

    content_type = response.headers.get("content-type", "")
    if "json" in content_type:
        try:
            response_body = response.json()
        except Exception:
            response_body = response.text
    else:
        response_body = response.text

    result: dict[str, Any] = {
        "status": response.status_code,
        "headers": dict(response.headers),
        "body": response_body,
    }
    if response.status_code == 403:
        result["hint"] = (
            "403 from the data plane. Two common causes: (1) wrong sub-path: the Tractus-X "
            "public API is at '<endpoint>/public/', which this tool appends by default; pass an "
            "explicit 'path' only if your asset needs a different one. (2) the EDR token expired: "
            "re-initiate the transfer and fetch again (Tractus-X refreshes tokens when the EDR is "
            "re-resolved)."
        )
    return result


if __name__ == "__main__":
    mcp.run()
