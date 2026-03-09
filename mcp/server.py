#!/usr/bin/env python3
"""
Dataspace Connector MCP Server

Provides tools for interacting with Eclipse Dataspace Components' Connector Management API:
- create_asset: Create a new asset with data address
- create_policy_definition: Create a new policy definition
- create_contract_definition: Create a new contract definition
- request_catalog: Request EDC connector catalog from a counterparty
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
_aws_credentials = None

if USE_AWS_IAM:
    _aws_session = boto3.Session()
    _aws_credentials = _aws_session.get_credentials()


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

    # Refresh credentials if needed (for temporary credentials)
    frozen_credentials = _aws_credentials.get_frozen_credentials()

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

    # Prepare request
    url = f"{EDC_MANAGEMENT_URL}/v3/assets"
    headers = get_headers()
    body = json.dumps(payload).encode('utf-8')

    # Sign headers if AWS IAM is enabled
    signed_headers = sign_request("POST", url, headers, body)

    async with httpx.AsyncClient() as client:
        response = await client.post(
            url,
            content=body,
            headers=signed_headers,
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json()


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

    # Prepare request
    url = f"{EDC_MANAGEMENT_URL}/v3/policydefinitions"
    headers = get_headers()
    body = json.dumps(payload).encode('utf-8')

    # Sign headers if AWS IAM is enabled
    signed_headers = sign_request("POST", url, headers, body)

    async with httpx.AsyncClient() as client:
        response = await client.post(
            url,
            content=body,
            headers=signed_headers,
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json()


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

    # Prepare request
    url = f"{EDC_MANAGEMENT_URL}/v3/contractdefinitions"
    headers = get_headers()
    body = json.dumps(payload).encode('utf-8')

    # Sign headers if AWS IAM is enabled
    signed_headers = sign_request("POST", url, headers, body)

    async with httpx.AsyncClient() as client:
        response = await client.post(
            url,
            content=body,
            headers=signed_headers,
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json()


@mcp.tool()
async def request_catalog(
    counter_party_address: str,
    protocol: str = "dataspace-protocol-http",
    counter_party_id: Optional[str] = None,
    query_spec: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """
    Request the catalog from another EDC connector.

    This retrieves the available contract offers (datasets) from a provider connector.
    Use this to discover what data assets are available from a specific data provider.

    Args:
        counter_party_address: The DSP endpoint URL of the provider connector
        protocol: Protocol to use (default: "dataspace-protocol-http")
        counter_party_id: Optional BPN/DID of the provider
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
        "protocol": protocol,
    }

    if counter_party_id:
        payload["counterPartyId"] = counter_party_id

    if query_spec:
        payload["querySpec"] = query_spec

    # Prepare request
    url = f"{EDC_MANAGEMENT_URL}/v3/catalog/request"
    headers = get_headers()
    body = json.dumps(payload).encode('utf-8')

    # Sign headers if AWS IAM is enabled
    signed_headers = sign_request("POST", url, headers, body)

    async with httpx.AsyncClient() as client:
        response = await client.post(
            url,
            content=body,
            headers=signed_headers,
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json()


if __name__ == "__main__":
    mcp.run()
