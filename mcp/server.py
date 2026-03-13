#!/usr/bin/env python3
"""
Dataspace Connector MCP Server

Provides tools for interacting with Eclipse Dataspace Components' Connector Management API.

Provider-side tools:
- create_asset: Create a new asset with data address
- create_policy_definition: Create a new policy definition
- create_contract_definition: Create a new contract definition
- query_assets: List/search existing assets

Consumer-side tools:
- request_catalog: Request EDC connector catalog from a counterparty
- initiate_contract_negotiation: Start a contract negotiation with a provider
- get_negotiation_state: Poll the state of a contract negotiation
- get_contract_agreement: Retrieve a finalized contract agreement
- initiate_transfer: Start a data transfer using a contract agreement
- get_transfer_state: Poll the state of a transfer process
- get_edr_data_address: Get the endpoint data reference for an active transfer

Query tools:
- query_assets: List/search assets
- query_contract_negotiations: List/search contract negotiations
- query_transfer_processes: List/search transfer processes
- query_contract_agreements: List/search contract agreements
"""

import json
import os
from typing import Any, Optional
import httpx
import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from mcp.server.fastmcp import FastMCP

# Initialize FastMCP server
mcp = FastMCP("dataspace-connector")

# Configuration
EDC_MANAGEMENT_URL = os.getenv("EDC_MANAGEMENT_URL", "http://localhost:8080/management")
EDC_API_KEY = os.getenv("EDC_API_KEY", "")
USE_AWS_IAM = os.getenv("EDC_USE_AWS_IAM", "false").lower() == "true"
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")

# Initialize AWS session if IAM auth is enabled
_aws_session = None

if USE_AWS_IAM:
    _aws_session = boto3.Session()


def get_headers() -> dict[str, str]:
    """Get HTTP headers for API requests."""
    headers = {
        "Content-Type": "application/json",
        "X-Api-Key": EDC_API_KEY  # Always include, even if empty
    }
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


async def _api_request(method: str, path: str, payload: dict | None = None) -> dict[str, Any]:
    """Make an authenticated request to the EDC Management API."""
    url = f"{EDC_MANAGEMENT_URL}{path}"
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
        response.raise_for_status()
        return response.json()


@mcp.tool()
async def create_asset(
    asset_id: str,
    properties: dict[str, Any],
    data_address: dict[str, Any],
    private_properties: Optional[dict[str, Any]] = None,
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

    Returns:
        Response with asset ID and creation timestamp

    Example:
        create_asset(
            asset_id="my-dataset-1",
            properties={"name": "Sample Dataset", "contentType": "application/json"},
            data_address={"type": "HttpData", "baseUrl": "https://api.example.com/data"}
        )
    """
    payload = {
        "@context": {"@vocab": "https://w3id.org/edc/v0.0.1/ns/"},
        "@id": asset_id,
        "@type": "https://w3id.org/edc/v0.0.1/ns/Asset",
        "properties": properties,
        "dataAddress": {
            "@type": "https://w3id.org/edc/v0.0.1/ns/DataAddress",
            **data_address,
        },
    }
    if private_properties:
        payload["privateProperties"] = private_properties

    return await _api_request("POST", "/v3/assets", payload)


@mcp.tool()
async def create_policy_definition(
    policy_id: str,
    policy: dict[str, Any],
) -> dict[str, Any]:
    """
    Create a new policy definition in the EDC connector.

    A policy definition contains ODRL policy rules that govern access to and usage of assets.
    Policies can include permissions, prohibitions, and obligations.

    Args:
        policy_id: Unique identifier for the policy definition
        policy: ODRL policy object with permissions, prohibitions, and obligations

    Returns:
        Response with policy definition ID and creation timestamp

    Example:
        create_policy_definition(
            policy_id="allow-all-policy",
            policy={
                "@context": "http://www.w3.org/ns/odrl.jsonld",
                "@type": "Set",
                "permission": [{
                    "action": "use",
                    "target": "my-dataset-1"
                }]
            }
        )
    """
    payload = {
        "@context": {"@vocab": "https://w3id.org/edc/v0.0.1/ns/"},
        "@id": policy_id,
        "@type": "https://w3id.org/edc/v0.0.1/ns/PolicyDefinition",
        "policy": policy,
    }
    return await _api_request("POST", "/v3/policydefinitions", payload)


@mcp.tool()
async def create_contract_definition(
    contract_definition_id: str,
    access_policy_id: str,
    contract_policy_id: str,
    assets_selector: list[dict[str, Any]],
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
            }]
        )
    """
    payload = {
        "@context": {"@vocab": "https://w3id.org/edc/v0.0.1/ns/"},
        "@id": contract_definition_id,
        "@type": "https://w3id.org/edc/v0.0.1/ns/ContractDefinition",
        "accessPolicyId": access_policy_id,
        "contractPolicyId": contract_policy_id,
        "assetsSelector": assets_selector,
    }
    return await _api_request("POST", "/v3/contractdefinitions", payload)


@mcp.tool()
async def request_catalog(
    counter_party_address: str,
    counter_party_id: str,
    protocol: str = "dataspace-protocol-http",
    query_spec: Optional[dict[str, Any]] = None,
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

    Returns:
        Catalog containing available datasets and contract offers

    Example:
        request_catalog(
            counter_party_address="https://provider.example.com/dsp",
            counter_party_id="BPNL000000000001"
        )
    """
    payload = {
        "@context": {"@vocab": "https://w3id.org/edc/v0.0.1/ns/"},
        "@type": "https://w3id.org/edc/v0.0.1/ns/CatalogRequest",
        "counterPartyAddress": counter_party_address,
        "counterPartyId": counter_party_id,
        "protocol": protocol,
    }
    if query_spec:
        payload["querySpec"] = query_spec

    return await _api_request("POST", "/v3/catalog/request", payload)


# --- Contract Negotiation ---


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
) -> dict[str, Any]:
    """
    Initiate a contract negotiation with a provider connector.

    Starts an asynchronous negotiation for a specific offer obtained from the catalog.
    Poll get_negotiation_state to track progress.

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
            obligation=[]
        )
    """
    policy: dict[str, Any] = {
        "@context": "http://www.w3.org/ns/odrl.jsonld",
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
        "@context": {"@vocab": "https://w3id.org/edc/v0.0.1/ns/"},
        "@type": "https://w3id.org/edc/v0.0.1/ns/ContractRequest",
        "counterPartyAddress": counter_party_address,
        "protocol": protocol,
        "policy": policy,
    }
    if callback_addresses:
        payload["callbackAddresses"] = callback_addresses

    return await _api_request("POST", "/v3/contractnegotiations", payload)


@mcp.tool()
async def get_negotiation_state(
    negotiation_id: str,
) -> dict[str, Any]:
    """
    Get the state of a contract negotiation.

    Use this to poll the progress of an asynchronous contract negotiation.
    Common states: REQUESTED, AGREED, VERIFIED, FINALIZED, TERMINATED.

    Args:
        negotiation_id: The ID returned by initiate_contract_negotiation

    Returns:
        The current negotiation state

    Example:
        get_negotiation_state(negotiation_id="negotiation-id")
    """
    return await _api_request("GET", f"/v3/contractnegotiations/{negotiation_id}/state")


@mcp.tool()
async def get_contract_agreement(
    agreement_id: str,
) -> dict[str, Any]:
    """
    Get a contract agreement by ID.

    Retrieves the finalized contract agreement, which contains the agreed-upon policy,
    asset ID, and the contract ID needed to initiate a transfer.

    Args:
        agreement_id: The contract agreement ID

    Returns:
        The contract agreement with policy, asset, provider/consumer IDs

    Example:
        get_contract_agreement(agreement_id="agreement-id")
    """
    return await _api_request("GET", f"/v3/contractagreements/{agreement_id}")


# --- Transfer Process ---


@mcp.tool()
async def initiate_transfer(
    counter_party_address: str,
    contract_id: str,
    transfer_type: str,
    protocol: str = "dataspace-protocol-http",
    data_destination: Optional[dict[str, Any]] = None,
    callback_addresses: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """
    Initiate a data transfer using a contract agreement.

    Starts an asynchronous transfer process. Poll get_transfer_state to track progress.
    For HTTP pull transfers, use transfer_type="HttpData-PULL" and no data_destination.
    After the transfer reaches STARTED state, use get_edr_data_address to get the access token.

    Args:
        counter_party_address: The DSP endpoint URL of the provider connector
        contract_id: The contract agreement ID from a finalized negotiation
        transfer_type: The transfer type (e.g., "HttpData-PULL", "HttpData-PUSH", "AmazonS3-PUSH")
        protocol: Protocol to use (default: "dataspace-protocol-http")
        data_destination: Optional destination data address (required for PUSH transfers)
        callback_addresses: Optional webhook addresses for transfer events

    Returns:
        Response with transfer process ID and created timestamp

    Example:
        initiate_transfer(
            counter_party_address="https://provider.example.com/dsp",
            contract_id="contract-agreement-id",
            transfer_type="HttpData-PULL"
        )
    """
    payload: dict[str, Any] = {
        "@context": {"@vocab": "https://w3id.org/edc/v0.0.1/ns/"},
        "@type": "https://w3id.org/edc/v0.0.1/ns/TransferRequest",
        "counterPartyAddress": counter_party_address,
        "contractId": contract_id,
        "transferType": transfer_type,
        "protocol": protocol,
    }
    if data_destination:
        payload["dataDestination"] = data_destination
    else:
        # EDC requires a dataDestination even for PULL transfers to avoid NPE
        # in resource definition generators. HttpProxy signals a client-pull.
        payload["dataDestination"] = {"@type": "https://w3id.org/edc/v0.0.1/ns/DataAddress", "type": "HttpProxy"}
    if callback_addresses:
        payload["callbackAddresses"] = callback_addresses

    return await _api_request("POST", "/v3/transferprocesses", payload)


@mcp.tool()
async def get_transfer_state(
    transfer_process_id: str,
) -> dict[str, Any]:
    """
    Get the state of a transfer process.

    Use this to poll the progress of an asynchronous data transfer.
    Common states: REQUESTED, STARTED, COMPLETED, TERMINATED, SUSPENDED.

    Args:
        transfer_process_id: The ID returned by initiate_transfer

    Returns:
        The current transfer process state

    Example:
        get_transfer_state(transfer_process_id="transfer-id")
    """
    return await _api_request("GET", f"/v3/transferprocesses/{transfer_process_id}/state")


# --- EDR Cache ---


@mcp.tool()
async def get_edr_data_address(
    transfer_process_id: str,
) -> dict[str, Any]:
    """
    Get the endpoint data reference (EDR) for an active transfer.

    Returns the data address containing the authorization token and endpoint URL
    needed to fetch data from the provider's data plane. Only available after
    a transfer process reaches the STARTED state.

    Args:
        transfer_process_id: The transfer process ID

    Returns:
        Data address with endpoint URL and authorization token

    Example:
        get_edr_data_address(transfer_process_id="transfer-id")
    """
    return await _api_request("GET", f"/v2/edrs/{transfer_process_id}/dataaddress")


# --- Query Tools ---


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
        "@type": "https://w3id.org/edc/v0.0.1/ns/QuerySpec",
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
async def query_assets(
    offset: int = 0,
    limit: int = 50,
    filter_expression: Optional[list[dict[str, Any]]] = None,
    sort_field: Optional[str] = None,
    sort_order: str = "ASC",
) -> list[dict[str, Any]]:
    """
    Query assets in the EDC connector.

    Args:
        offset: Pagination offset (default: 0)
        limit: Maximum results to return (default: 50)
        filter_expression: Optional filter criteria as list of Criterion objects
        sort_field: Optional field name to sort by
        sort_order: Sort direction, "ASC" or "DESC" (default: "ASC")

    Returns:
        List of assets matching the query

    Example:
        query_assets(limit=10)
        query_assets(filter_expression=[{
            "operandLeft": "https://w3id.org/edc/v0.0.1/ns/id",
            "operator": "=",
            "operandRight": "my-asset-id"
        }])
    """
    payload = _build_query_spec(offset, limit, filter_expression, sort_field, sort_order)
    return await _api_request("POST", "/v3/assets/request", payload)


@mcp.tool()
async def query_contract_negotiations(
    offset: int = 0,
    limit: int = 50,
    filter_expression: Optional[list[dict[str, Any]]] = None,
    sort_field: Optional[str] = None,
    sort_order: str = "ASC",
) -> list[dict[str, Any]]:
    """
    Query contract negotiations in the EDC connector.

    Args:
        offset: Pagination offset (default: 0)
        limit: Maximum results to return (default: 50)
        filter_expression: Optional filter criteria as list of Criterion objects
        sort_field: Optional field name to sort by
        sort_order: Sort direction, "ASC" or "DESC" (default: "ASC")

    Returns:
        List of contract negotiations matching the query

    Example:
        query_contract_negotiations(limit=10)
        query_contract_negotiations(filter_expression=[{
            "operandLeft": "state",
            "operator": "=",
            "operandRight": "FINALIZED"
        }])
    """
    payload = _build_query_spec(offset, limit, filter_expression, sort_field, sort_order)
    return await _api_request("POST", "/v3/contractnegotiations/request", payload)


@mcp.tool()
async def query_transfer_processes(
    offset: int = 0,
    limit: int = 50,
    filter_expression: Optional[list[dict[str, Any]]] = None,
    sort_field: Optional[str] = None,
    sort_order: str = "ASC",
) -> list[dict[str, Any]]:
    """
    Query transfer processes in the EDC connector.

    Args:
        offset: Pagination offset (default: 0)
        limit: Maximum results to return (default: 50)
        filter_expression: Optional filter criteria as list of Criterion objects
        sort_field: Optional field name to sort by
        sort_order: Sort direction, "ASC" or "DESC" (default: "ASC")

    Returns:
        List of transfer processes matching the query

    Example:
        query_transfer_processes(limit=10)
        query_transfer_processes(filter_expression=[{
            "operandLeft": "state",
            "operator": "=",
            "operandRight": "STARTED"
        }])
    """
    payload = _build_query_spec(offset, limit, filter_expression, sort_field, sort_order)
    return await _api_request("POST", "/v3/transferprocesses/request", payload)


@mcp.tool()
async def query_contract_agreements(
    offset: int = 0,
    limit: int = 50,
    filter_expression: Optional[list[dict[str, Any]]] = None,
    sort_field: Optional[str] = None,
    sort_order: str = "ASC",
) -> list[dict[str, Any]]:
    """
    Query contract agreements in the EDC connector.

    Args:
        offset: Pagination offset (default: 0)
        limit: Maximum results to return (default: 50)
        filter_expression: Optional filter criteria as list of Criterion objects
        sort_field: Optional field name to sort by
        sort_order: Sort direction, "ASC" or "DESC" (default: "ASC")

    Returns:
        List of contract agreements matching the query

    Example:
        query_contract_agreements(limit=10)
        query_contract_agreements(filter_expression=[{
            "operandLeft": "assetId",
            "operator": "=",
            "operandRight": "my-asset-id"
        }])
    """
    payload = _build_query_spec(offset, limit, filter_expression, sort_field, sort_order)
    return await _api_request("POST", "/v3/contractagreements/request", payload)


if __name__ == "__main__":
    mcp.run()
