#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Regenerates the connector-scoped paths of cdk/api/*.yaml from the OpenAPI documents of
# the control plane and data plane builds. Every run rebuilds those paths from scratch, so
# the specs match the EDC version on the classpath. Routes are assigned by the OpenAPI tag
# of their EDC web context; an unknown tag stops the script, so an EDC upgrade that adds
# an API forces a decision here. Hand-written routes (BaSyx, the data-plane proxy) and the
# document headers are kept as they are.
#
# Usage (from the repo root):
#   (cd edc && ./gradlew resolveApi)
#   uv run --with ruamel.yaml python scripts/regenerate-api-specs.py
# Formats the specs with prettier afterwards (needs `npm ci` in cdk/).
import json
import os
import re
import subprocess
import sys

from ruamel.yaml import YAML

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
API = os.path.join(ROOT, "cdk/api")
METHODS = ("get", "post", "put", "delete", "patch")

# (plane, tag) -> (spec, path prefix in API Gateway, EDC web context path, address placeholder)
# or None for routes API Gateway does not expose. Untagged control-plane routes are DSP.
MANAGEMENT = ("management-api", "", "api/management", "loadBalancerDnsName")
ROUTES = {
    ("control-plane", None): ("dsp-api", "", "api/protocol", "loadBalancerDnsName"),
    ("control-plane", "Application Observability"): ("observability-api", "/control-plane", "api", "loadBalancerDnsName"),
    ("data-plane", "Application Observability"): ("observability-api", "/data-plane", "api", "dataPlaneDefaultAddress"),
    ("data-plane", "Token Refresh API"): ("data-plane-api", "", "api/public", "loadBalancerDnsName"),
    # Internal control APIs between the planes
    ("control-plane", "Transfer Process Control Api"): None,
    ("control-plane", "Dataplane Selector"): None,
    ("data-plane", "Data Plane Signaling api API"): None,
    # Federated catalog: its catalog context is not configured
    ("control-plane", "Federated Catalog"): None,
    # Version details are not exposed
    ("control-plane", "Version"): None,
    # Data-plane management and consumer proxy contexts are not configured
    ("data-plane", "DataFlow API V4Alpha"): None,
    ("data-plane", "Data Plane Proxy API"): None,
    # Served by the hand-written {any+} proxy route
    ("data-plane", "Data Plane public API"): None,
}
for tag in (
    "Agreements Retirement", "Asset V3", "Asset v4beta", "Business Partner Group", "Catalog V3",
    "Catalog v4beta", "Connector Discovery", "Contract Agreement V3", "Contract Agreement v4beta",
    "Contract Definition V3", "Contract Definition v4beta", "Contract Negotiation V3",
    "Contract Negotiation v4beta", "Control Plane EDR Api", "Dataplane Selector V3",
    "Dataplane Selector v4beta", "Policy Definition v3", "Policy Definition v4beta",
    "Transfer Process V3", "Transfer Process v4beta",
):
    ROUTES[("control-plane", tag)] = MANAGEMENT

# Spec -> IAM auth on every generated route
SPECS = {"management-api": True, "dsp-api": False, "observability-api": True, "data-plane-api": False}
# Hand-written connector-scoped routes that survive regeneration
KEEP = {"/{connectorId}/{any+}"}

yaml = YAML()
yaml.preserve_quotes = True
yaml.width = 4096
yaml.indent(mapping=2, sequence=4, offset=2)


def responses(op):
    out = {}
    for code, r in sorted((op.get("responses") or {}).items()):
        schema = r.get("content", {}).get("application/json", {}).get("schema", {})
        body = {"type": "array", "items": {"type": "object"}} if schema.get("type") == "array" else {"type": "object"}
        out[code] = {"description": r.get("description", ""), "content": {"application/json": {"schema": body}}}
    return out or {"default": {"description": "default response"}}


def operation(path, method, op, route, auth):
    _, prefix, context, address = route
    path_params = re.findall(r"\{([^}]+)\}", path)
    parameters = [{"$ref": "#/components/parameters/ConnectorId"}]
    parameters += [{"in": "path", "name": p, "required": True, "schema": {"type": "string"}} for p in path_params]
    parameters += [
        {"in": p["in"], "name": p["name"], "required": bool(p.get("required")), "schema": {"type": "string"}}
        for p in op.get("parameters") or []
        if p.get("in") in ("query", "header")
    ]
    # Both planes serve the same health operations, so the prefix keeps operation IDs unique.
    op_id = op.get("operationId", f"{method}{path}")
    if prefix:
        op_id = re.sub(r"-(\w)", lambda m: m[1].upper(), prefix.strip("/")) + op_id[0].upper() + op_id[1:]
    out = {"operationId": op_id, "parameters": parameters}
    if op.get("description"):
        out["description"] = op["description"]
    if op.get("tags"):
        out["tags"] = op["tags"]
    if "application/json" in ((op.get("requestBody") or {}).get("content") or {}):
        out["requestBody"] = {"content": {"application/json": {"schema": {"type": "object"}}}}
    out["responses"] = responses(op)
    if auth:
        out["x-amazon-apigateway-auth"] = {"type": "AWS_IAM"}
    out["x-amazon-apigateway-integration"] = {
        "type": "http_proxy",
        "httpMethod": method.upper(),
        "connectionId": "${vpcLinkId}",
        "connectionType": "VPC_LINK",
        "requestParameters": {
            f"integration.request.path.{p}": f"method.request.path.{p}" for p in ["connectorId", *path_params]
        },
        "uri": f"http://${{{address}}}/{{connectorId}}/{context}{path}",
        "integrationTarget": "${albArn}",
    }
    return out


generated = {name: {} for name in SPECS}
for plane in ("control-plane", "data-plane"):
    edc = json.load(open(os.path.join(ROOT, f"edc/{plane}/build/openapi/{plane}-openapi.json")))["paths"]
    for path in sorted(edc):
        ops = {m: o for m, o in edc[path].items() if m in METHODS}
        tags = {t for o in ops.values() for t in o.get("tags") or []} or {None}
        if len(tags) != 1:
            sys.exit(f"{plane} {path}: operations carry different tags {tags}")
        tag = tags.pop()
        if (plane, tag) not in ROUTES:
            sys.exit(f"{plane} {path}: unknown tag {tag!r}, add it to ROUTES")
        route = ROUTES[(plane, tag)]
        if route and ops:
            name = route[0]
            generated[name][f"/{{connectorId}}{route[1]}{path}"] = {
                m: operation(path, m, ops[m], route, SPECS[name]) for m in METHODS if m in ops
            }

for name, paths in generated.items():
    if not paths:
        sys.exit(f"{name}: no EDC paths matched, check ROUTES")
    file = os.path.join(API, f"{name}.yaml")
    doc = yaml.load(open(file))
    own = {p: v for p, v in doc["paths"].items() if not p.startswith("/{connectorId}/") or p in KEEP}
    doc["paths"] = {**paths, **own}
    doc["components"].pop("schemas", None)  # generated operations reference no schemas
    with open(file, "w") as f:
        yaml.dump(doc, f)
    print(f"{name}: {len(paths)} EDC paths")

subprocess.run(["npx", "prettier", "--write", *(f"api/{n}.yaml" for n in SPECS)], cwd=os.path.join(ROOT, "cdk"), check=True)
