#!/usr/bin/env python3
"""
Dataspace Connector MCP Server

Provides tools for interacting with Eclipse Dataspace Components' Connector Management API.

Supports two modes:
- Legacy (single connector): Set EDC_MANAGEMENT_URL only. All tools target that endpoint directly.
- Multi-connector (Dataspace Connector on AWS): Set EDC_MANAGEMENT_URL + EDC_MULTI_CONNECTOR=true.
  Enables dynamic connector discovery via CloudFormation and requires connector_id on all tools.

Provider-side tools:
- create_asset: Create a new asset with data address
- create_policy_definition: Create a new policy definition
- create_contract_definition: Create a new contract definition

Consumer-side tools:
- request_catalog: Request EDC connector catalog from a counterparty
- initiate_contract_negotiation: Start a contract negotiation with a provider
- get_contract_negotiation: Get the full contract negotiation object
- get_contract_agreement: Retrieve a finalized contract agreement
- initiate_transfer: Start a data transfer using a contract agreement
- get_transfer_process: Get the full transfer process object
- get_edr_data_address: Get the endpoint data reference for an active transfer
- initiate_edr_negotiation: Combined negotiation + transfer in one call
- fetch_data_with_edr: Fetch actual data from the provider using an EDR

Query tools:
- query_assets: List/search assets
- query_policy_definitions: List/search policy definitions
- query_contract_definitions: List/search contract definitions
- query_contract_negotiations: List/search contract negotiations
- query_transfer_processes: List/search transfer processes
- query_contract_agreements: List/search contract agreements

Discovery tools (multi-connector mode only):
- list_connectors: Discover deployed connector IDs from CloudFormation
"""

import json
import os
from typing import Any, Optional
import httpx
import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from mcp.server.fastmcp import FastMCP

# Configuration
EDC_MANAGEMENT_URL = os.getenv("EDC_MANAGEMENT_URL", "http://localhost:8080/management").rstrip("/")
EDC_API_KEY = os.getenv("EDC_API_KEY", "")
USE_AWS_IAM = os.getenv("EDC_USE_AWS_IAM", "false").lower() == "true"
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
MULTI_CONNECTOR = os.getenv("EDC_MULTI_CONNECTOR", "false").lower() == "true"

# CloudFormation stack prefix used by Dataspace Connector on AWS deployments
_CFN_STACK_PREFIX = "Deploy-DataspaceConnector-"
_CFN_SHARED_INFRA_SUFFIX = "SharedInfraStack"

# Initialize FastMCP server with mode-dependent instructions
_MULTI_INSTRUCTIONS = (
    "This server manages multiple EDC connectors deployed via Dataspace Connector on AWS. "
    "ALWAYS call list_connectors first to discover available connector IDs before using any other tool. "
    "All other tools require a connector_id parameter — pass the connector ID returned by list_connectors."
)

mcp = FastMCP(
    "dataspace-connector",
    instructions=_MULTI_INSTRUCTIONS if MULTI_CONNECTOR else None,
)

# Initialize AWS session if IAM auth or multi-connector discovery is enabled
_aws_session = None

if USE_AWS_IAM or MULTI_CONNECTOR:
    _aws_session = boto3.Session()


def _resolve_management_url(connector_id: Optional[str]) -> str:
    """Resolve the Management API base URL for a request.

    In multi-connector mode, connector_id is prepended as a path segment.
    In legacy mode, the EDC_MANAGEMENT_URL is used directly.
    """
    if MULTI_CONNECTOR:
        if not connector_id:
            raise ValueError(
                "connector_id is required in multi-connector mode. "
                "Call list_connectors first to discover available connector IDs."
            )
        return f"{EDC_MANAGEMENT_URL}/{connector_id}"
    else:
        return EDC_MANAGEMENT_URL


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

    # Get fresh credentials each time to handle expiration of temporary credentials
    credentials = _aws_session.get_credentials()
    frozen_credentials = credentials.get_frozen_credentials()

    # Ensure we have the required headers for signing
    if body and "Content-Type" not in headers:
        headers["Content-Type"] = "application/json"

    # Create AWS request
    aws_request = AWSRequest(
        method=method,
        url=url,
        data=body,
        headers=headers
    )

    # Sign it
    SigV4Auth(frozen_credentials, "execute-api", AWS_REGION).add_auth(aws_request)

    # Return signed headers
    return dict(aws_request.headers)


async def _api_request(method: str, path: str, payload: dict | None = None, connector_id: Optional[str] = None) -> dict[str, Any]:
    """Make an authenticated request to the EDC Management API."""
    base_url = _resolve_management_url(connector_id)
    url = f"{base_url}{path}"
    headers = get_headers()
    body = json.dumps(payload).encode('utf-8') if payload else None

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
            # Return structured error so the agent sees status code and body
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
            }

        return response.json()


# ─── Discovery Tool ────────────────────────────────────────────────────────────


@mcp.tool()
async def list_connectors() -> dict[str, Any]:
    """
    Discover deployed EDC connector IDs from CloudFormation.

    Queries AWS CloudFormation for stacks deployed by Dataspace Connector on AWS
    and returns the list of active connector IDs. Use these IDs as the connector_id
    parameter in all other tools.

    Requires EDC_MULTI_CONNECTOR=true and cloudformation:ListStacks IAM permission.

    Returns:
        Dictionary with connector_ids list and management_base_url

    Example:
        list_connectors()
        # → {"connector_ids": ["zentra-motors", "ferrotec", "voltwerk", ...], "management_base_url": "https://..."}
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
        cfn_client = _aws_session.client("cloudformation", region_name=AWS_REGION)
        paginator = cfn_client.get_paginator("list_stacks")

        connector_ids = []
        for page in paginator.paginate(
            StackStatusFilter=["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]
        ):
            for stack in page.get("StackSummaries", []):
                name = stack["StackName"]
                if name.startswith(_CFN_STACK_PREFIX) and not name.endswith(_CFN_SHARED_INFRA_SUFFIX):
                    connector_id = name[len(_CFN_STACK_PREFIX):]
                    connector_ids.append(connector_id)

        connector_ids.sort()

        return {
            "connector_ids": connector_ids,
            "count": len(connector_ids),
            "management_base_url": EDC_MANAGEMENT_URL,
            "region": AWS_REGION,
        }

    except Exception as e:
        return {
            "error": True,
            "message": f"Failed to discover connectors from CloudFormation: {str(e)}",
            "hint": "Ensure your AWS credentials have cloudformation:ListStacks permission.",
        }


# ─── Provider Tools ────────────────────────────────────────────────────────────


@mcp.tool()
async def create_asset(
    asset_id: str,
    properties: dict[str, Any],
    data_address: dict[str, Any],
    private_properties: Optional[dict[str, Any]] = None,
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Create a new asset in the EDC connector.

    An asset represents a data resource that can be shared through the dataspace.
    It includes metadata (properties) and information about how to access the data (dataAddress).

    Args:
        asset_id: Unique identifier for the asset
        properties: Public metadata about the asset (e.g., name, description, contentType)
        data_address: Information about how to access the data (type, baseUrl, etc.)
        private_properties: Optional private metadata not shared in catalog
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        Response with asset ID and creation timestamp

    Example:
        create_asset(
            asset_id="my-dataset-1",
            properties={"name": "Sample Dataset", "contentType": "application/json"},
            data_address={"type": "HttpData", "baseUrl": "https://api.example.com/data"},
            connector_id="ferrotec"
        )
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
async def create_policy_definition(
    policy_id: str,
    policy: dict[str, Any],
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Create a new policy definition in the EDC connector.

    A policy definition contains ODRL policy rules that govern access to and usage of assets.
    Policies can include permissions, prohibitions, and obligations.

    Args:
        policy_id: Unique identifier for the policy definition
        policy: ODRL policy object with permissions, prohibitions, and obligations
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        Response with policy definition ID and creation timestamp

    Example:
        create_policy_definition(
            policy_id="usage-policy",
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
            },
            connector_id="ferrotec"
        )
    """
    payload = {
        "@context": [
            "https://w3id.org/dspace/2025/1/odrl-profile.jsonld",
            "https://w3id.org/catenax/2025/9/policy/context.jsonld",
            {"@vocab": "https://w3id.org/edc/v0.0.1/ns/"},
        ],
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
    Create a new contract definition in the EDC connector.

    A contract definition links assets to policies and makes them available in the catalog.
    It specifies which assets are offered under which access and contract policies.

    Args:
        contract_definition_id: Unique identifier for the contract definition
        access_policy_id: ID of policy that controls who can see the offer
        contract_policy_id: ID of policy that governs the actual data usage
        assets_selector: Criteria to select which assets this contract applies to
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        Response with contract definition ID and creation timestamp

    Example:
        create_contract_definition(
            contract_definition_id="my-contract-def",
            access_policy_id="allow-all-policy",
            contract_policy_id="usage-policy",
            assets_selector=[{
                "operandLeft": "https://w3id.org/edc/v0.0.1/ns/id",
                "operator": "=",
                "operandRight": "my-dataset-1"
            }],
            connector_id="ferrotec"
        )
    """
    payload = {
        "@context": {"@vocab": "https://w3id.org/edc/v0.0.1/ns/"},
        "@id": contract_definition_id,
        "@type": "ContractDefinition",
        "accessPolicyId": access_policy_id,
        "contractPolicyId": contract_policy_id,
        "assetsSelector": assets_selector,
    }
    return await _api_request("POST", "/v3/contractdefinitions", payload, connector_id=connector_id)


# ─── Consumer Tools ────────────────────────────────────────────────────────────


@mcp.tool()
async def request_catalog(
    counter_party_address: str,
    counter_party_id: str,
    protocol: str = "dataspace-protocol-http",
    query_spec: Optional[dict[str, Any]] = None,
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Request the catalog from another EDC connector.

    This retrieves the available contract offers (datasets) from a provider connector.
    Use this to discover what data assets are available from a specific data provider.

    Args:
        counter_party_address: The DSP endpoint URL of the provider connector
        counter_party_id: BPN/DID of the provider participant
        protocol: Protocol to use (default: "dataspace-protocol-http")
        query_spec: Optional query specification for filtering/pagination
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        Catalog containing available datasets and contract offers

    Example:
        request_catalog(
            counter_party_address="https://provider.example.com/dsp",
            counter_party_id="BPNL000000000001",
            connector_id="zentra-motors"
        )
    """
    payload = {
        "@context": [{"@vocab": "https://w3id.org/edc/v0.0.1/ns/"}],
        "@type": "CatalogRequest",
        "counterPartyAddress": counter_party_address,
        "counterPartyId": counter_party_id,
        "protocol": protocol,
    }
    if query_spec:
        payload["querySpec"] = query_spec

    return await _api_request("POST", "/v3/catalog/request", payload, connector_id=connector_id)


@mcp.tool()
async def initiate_contract_negotiation(
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
    Initiate a contract negotiation with a provider connector.

    Starts an asynchronous negotiation for a specific offer obtained from the catalog.
    Poll get_contract_negotiation to track progress.

    Args:
        counter_party_address: The DSP endpoint URL of the provider connector
        offer_id: The offer/policy ID from the catalog (the "@id" of the odrl:hasPolicy)
        asset_id: The target asset ID from the catalog offer
        assigner: The provider participant ID (assigner of the offer)
        protocol: Protocol to use (default: "dataspace-protocol-http")
        permission: The permission array from the catalog offer's odrl:hasPolicy (pass it through exactly)
        prohibition: The prohibition array from the catalog offer's odrl:hasPolicy (pass it through exactly)
        obligation: The obligation array from the catalog offer's odrl:hasPolicy (pass it through exactly)
        callback_addresses: Optional webhook addresses for negotiation events
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        Response with negotiation ID and created timestamp

    Example:
        initiate_contract_negotiation(
            counter_party_address="https://provider.example.com/dsp",
            offer_id="offer-id-from-catalog",
            asset_id="asset-id",
            assigner="provider-participant-id",
            permission=[{"action": "use"}],
            prohibition=[],
            obligation=[],
            connector_id="zentra-motors"
        )
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
        "@context": [
            "https://w3id.org/dspace/2025/1/odrl-profile.jsonld",
            "https://w3id.org/catenax/2025/9/policy/context.jsonld",
            {"@vocab": "https://w3id.org/edc/v0.0.1/ns/"},
        ],
        "@type": "ContractRequest",
        "counterPartyAddress": counter_party_address,
        "protocol": protocol,
        "policy": policy,
    }
    if callback_addresses:
        payload["callbackAddresses"] = callback_addresses

    return await _api_request("POST", "/v3/contractnegotiations", payload, connector_id=connector_id)


@mcp.tool()
async def get_contract_negotiation(
    negotiation_id: str,
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Get the state of a contract negotiation.

    Use this to poll the progress of an asynchronous contract negotiation.
    Common states: REQUESTED, AGREED, VERIFIED, FINALIZED, TERMINATED.

    Args:
        negotiation_id: The ID returned by initiate_contract_negotiation
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        The full contract negotiation object including state and agreement ID
    """
    return await _api_request("GET", f"/v3/contractnegotiations/{negotiation_id}", connector_id=connector_id)


@mcp.tool()
async def get_contract_agreement(
    agreement_id: str,
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Get a contract agreement by ID.

    Retrieves the finalized contract agreement, which contains the agreed-upon policy,
    asset ID, and the contract ID needed to initiate a transfer.

    Args:
        agreement_id: The contract agreement ID
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        The contract agreement with policy, asset, provider/consumer IDs
    """
    return await _api_request("GET", f"/v3/contractagreements/{agreement_id}", connector_id=connector_id)


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
    Initiate a data transfer using a contract agreement.

    Starts an asynchronous transfer process. Poll get_transfer_process to track progress.
    For HTTP pull transfers, use transfer_type="HttpData-PULL" and no data_destination.

    Args:
        counter_party_address: The DSP endpoint URL of the provider connector
        contract_id: The contract agreement ID from a finalized negotiation
        transfer_type: The transfer type (e.g., "HttpData-PULL", "HttpData-PUSH", "AmazonS3-PUSH")
        protocol: Protocol to use (default: "dataspace-protocol-http")
        data_destination: Optional destination data address (required for PUSH transfers)
        callback_addresses: Optional webhook addresses for transfer events
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        Response with transfer process ID and created timestamp
    """
    payload: dict[str, Any] = {
        "@context": {"@vocab": "https://w3id.org/edc/v0.0.1/ns/"},
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


@mcp.tool()
async def get_transfer_process(
    transfer_process_id: str,
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Get the state of a transfer process.

    Common states: REQUESTED, STARTED, COMPLETED, TERMINATED, SUSPENDED.

    Args:
        transfer_process_id: The ID returned by initiate_transfer
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        The full transfer process object including state and error details
    """
    return await _api_request("GET", f"/v3/transferprocesses/{transfer_process_id}", connector_id=connector_id)


@mcp.tool()
async def get_edr_data_address(
    transfer_process_id: str,
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Get the endpoint data reference (EDR) for an active transfer.

    Returns the data address containing the authorization token and endpoint URL
    needed to fetch data from the provider's data plane. Only available after
    a transfer process reaches the STARTED state.

    Args:
        transfer_process_id: The transfer process ID
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        Data address with endpoint URL and authorization token
    """
    return await _api_request("GET", f"/v3/edrs/{transfer_process_id}/dataaddress", connector_id=connector_id)


@mcp.tool()
async def fetch_data_with_edr(
    transfer_process_id: str,
    method: str = "GET",
    path: Optional[str] = None,
    query_params: Optional[dict[str, str]] = None,
    body: Optional[dict[str, Any]] = None,
    media_type: Optional[str] = None,
    connector_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Fetch data from the provider's data plane using an EDR (Endpoint Data Reference).

    This is the final step in the consumer PULL flow. It resolves the EDR for the given
    transfer process, then makes an HTTP request to the provider's data plane public API.

    Args:
        transfer_process_id: The transfer process ID (must have an active EDR)
        method: HTTP method to use (default: "GET")
        path: Optional sub-path to append to the EDR endpoint URL
        query_params: Optional query parameters to include in the request
        body: Optional JSON request body (for POST, PUT, PATCH)
        media_type: Optional media type for the request body (default: "application/json")
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        Dictionary with "status", "headers", and "body"
    """
    # Step 1: Resolve the EDR
    edr = await _api_request("GET", f"/v3/edrs/{transfer_process_id}/dataaddress", connector_id=connector_id)

    if edr.get("error"):
        return edr

    # Step 2: Extract endpoint and authorization
    endpoint = (
        edr.get("endpoint")
        or edr.get("https://w3id.org/edc/v0.0.1/ns/endpoint")
    )
    authorization = (
        edr.get("authorization")
        or edr.get("https://w3id.org/edc/v0.0.1/ns/authorization")
    )

    if not endpoint:
        return {"error": "EDR does not contain an endpoint URL", "edr": edr}
    if not authorization:
        return {"error": "EDR does not contain an authorization token", "edr": edr}

    # Step 3: Build the target URL
    target_url = endpoint.rstrip("/")
    sub_path = path if path is not None else "public/"
    target_url = f"{target_url}/{sub_path.lstrip('/')}"

    # Step 4: Build headers
    headers: dict[str, str] = {"Authorization": authorization}
    if body is not None:
        headers["Content-Type"] = media_type or "application/json"

    # Step 5: Make the request
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

    # Step 6: Build the response
    response_headers = dict(response.headers)
    content_type = response.headers.get("content-type", "")

    if "json" in content_type:
        try:
            response_body = response.json()
        except Exception:
            response_body = response.text
    else:
        response_body = response.text

    return {
        "status": response.status_code,
        "headers": response_headers,
        "body": response_body,
    }


@mcp.tool()
async def initiate_edr_negotiation(
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
    Initiate an EDR negotiation that combines contract negotiation and transfer in one call.

    This is a convenience shortcut that handles the full flow: contract negotiation,
    followed by an automatic HttpData-PULL transfer.

    Args:
        counter_party_address: The DSP endpoint URL of the provider connector
        offer_id: The offer/policy ID from the catalog
        asset_id: The target asset ID from the catalog offer
        assigner: The provider participant ID
        protocol: Protocol to use (default: "dataspace-protocol-http")
        permission: The permission array from the catalog offer's odrl:hasPolicy
        prohibition: The prohibition array from the catalog offer's odrl:hasPolicy
        obligation: The obligation array from the catalog offer's odrl:hasPolicy
        callback_addresses: Optional webhook addresses for negotiation events
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        Response with negotiation ID and created timestamp
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
        "@context": [
            "https://w3id.org/dspace/2025/1/odrl-profile.jsonld",
            "https://w3id.org/catenax/2025/9/policy/context.jsonld",
            {"@vocab": "https://w3id.org/edc/v0.0.1/ns/"},
        ],
        "@type": "ContractRequest",
        "counterPartyAddress": counter_party_address,
        "protocol": protocol,
        "policy": policy,
    }
    if callback_addresses:
        payload["callbackAddresses"] = callback_addresses

    return await _api_request("POST", "/v3/edrs", payload, connector_id=connector_id)


# ─── Query Tools ───────────────────────────────────────────────────────────────


def _build_query_spec(
    offset: int = 0,
    limit: int = 50,
    filter_expression: Optional[list[dict[str, Any]]] = None,
    sort_field: Optional[str] = None,
    sort_order: str = "ASC",
) -> dict[str, Any]:
    """Build a QuerySpec payload."""
    spec: dict[str, Any] = {
        "@context": {"@vocab": "https://w3id.org/edc/v0.0.1/ns/"},
        "@type": "QuerySpec",
        "offset": offset,
        "limit": limit,
        "sortOrder": sort_order,
    }
    if sort_field:
        spec["sortField"] = sort_field
    if filter_expression:
        spec["filterExpression"] = filter_expression
    return spec


@mcp.tool()
async def query_policy_definitions(
    offset: int = 0,
    limit: int = 50,
    filter_expression: Optional[list[dict[str, Any]]] = None,
    sort_field: Optional[str] = None,
    sort_order: str = "ASC",
    connector_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    """
    Query policy definitions in the EDC connector.

    Args:
        offset: Pagination offset (default: 0)
        limit: Maximum results to return (default: 50)
        filter_expression: Optional filter criteria as list of Criterion objects
        sort_field: Optional field name to sort by
        sort_order: Sort direction, "ASC" or "DESC" (default: "ASC")
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        List of policy definitions matching the query
    """
    payload = _build_query_spec(offset, limit, filter_expression, sort_field, sort_order)
    return await _api_request("POST", "/v3/policydefinitions/request", payload, connector_id=connector_id)


@mcp.tool()
async def query_contract_definitions(
    offset: int = 0,
    limit: int = 50,
    filter_expression: Optional[list[dict[str, Any]]] = None,
    sort_field: Optional[str] = None,
    sort_order: str = "ASC",
    connector_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    """
    Query contract definitions in the EDC connector.

    Args:
        offset: Pagination offset (default: 0)
        limit: Maximum results to return (default: 50)
        filter_expression: Optional filter criteria as list of Criterion objects
        sort_field: Optional field name to sort by
        sort_order: Sort direction, "ASC" or "DESC" (default: "ASC")
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        List of contract definitions matching the query
    """
    payload = _build_query_spec(offset, limit, filter_expression, sort_field, sort_order)
    return await _api_request("POST", "/v3/contractdefinitions/request", payload, connector_id=connector_id)


@mcp.tool()
async def query_assets(
    offset: int = 0,
    limit: int = 50,
    filter_expression: Optional[list[dict[str, Any]]] = None,
    sort_field: Optional[str] = None,
    sort_order: str = "ASC",
    connector_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    """
    Query assets in the EDC connector.

    Args:
        offset: Pagination offset (default: 0)
        limit: Maximum results to return (default: 50)
        filter_expression: Optional filter criteria as list of Criterion objects
        sort_field: Optional field name to sort by
        sort_order: Sort direction, "ASC" or "DESC" (default: "ASC")
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        List of assets matching the query
    """
    payload = _build_query_spec(offset, limit, filter_expression, sort_field, sort_order)
    return await _api_request("POST", "/v3/assets/request", payload, connector_id=connector_id)


@mcp.tool()
async def query_contract_negotiations(
    offset: int = 0,
    limit: int = 50,
    filter_expression: Optional[list[dict[str, Any]]] = None,
    sort_field: Optional[str] = None,
    sort_order: str = "ASC",
    connector_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    """
    Query contract negotiations in the EDC connector.

    Args:
        offset: Pagination offset (default: 0)
        limit: Maximum results to return (default: 50)
        filter_expression: Optional filter criteria as list of Criterion objects
        sort_field: Optional field name to sort by
        sort_order: Sort direction, "ASC" or "DESC" (default: "ASC")
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        List of contract negotiations matching the query
    """
    payload = _build_query_spec(offset, limit, filter_expression, sort_field, sort_order)
    return await _api_request("POST", "/v3/contractnegotiations/request", payload, connector_id=connector_id)


@mcp.tool()
async def query_transfer_processes(
    offset: int = 0,
    limit: int = 50,
    filter_expression: Optional[list[dict[str, Any]]] = None,
    sort_field: Optional[str] = None,
    sort_order: str = "ASC",
    connector_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    """
    Query transfer processes in the EDC connector.

    Args:
        offset: Pagination offset (default: 0)
        limit: Maximum results to return (default: 50)
        filter_expression: Optional filter criteria as list of Criterion objects
        sort_field: Optional field name to sort by
        sort_order: Sort direction, "ASC" or "DESC" (default: "ASC")
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        List of transfer processes matching the query
    """
    payload = _build_query_spec(offset, limit, filter_expression, sort_field, sort_order)
    return await _api_request("POST", "/v3/transferprocesses/request", payload, connector_id=connector_id)


@mcp.tool()
async def query_contract_agreements(
    offset: int = 0,
    limit: int = 50,
    filter_expression: Optional[list[dict[str, Any]]] = None,
    sort_field: Optional[str] = None,
    sort_order: str = "ASC",
    connector_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    """
    Query contract agreements in the EDC connector.

    Args:
        offset: Pagination offset (default: 0)
        limit: Maximum results to return (default: 50)
        filter_expression: Optional filter criteria as list of Criterion objects
        sort_field: Optional field name to sort by
        sort_order: Sort direction, "ASC" or "DESC" (default: "ASC")
        connector_id: Target connector ID (required in multi-connector mode, from list_connectors)

    Returns:
        List of contract agreements matching the query
    """
    payload = _build_query_spec(offset, limit, filter_expression, sort_field, sort_order)
    return await _api_request("POST", "/v3/contractagreements/request", payload, connector_id=connector_id)


if __name__ == "__main__":
    mcp.run()
