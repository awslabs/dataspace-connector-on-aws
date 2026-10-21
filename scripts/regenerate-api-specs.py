#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Regenerate cdk/api management + dsp specs from the local 0.12.2 EDC build.
# Round-trip preserving (ruamel): keeps untouched operations and the file header
# byte-for-byte; only adds new 0.12.2 paths and removes /{connectorId} paths absent
# from 0.12.2. Paths outside /{connectorId} (the BaSyx route) are left alone.
#
# Usage (from repo root):
#   (cd edc && ./gradlew :control-plane:resolveApi)
#   uv run --with ruamel.yaml python scripts/regenerate-api-specs.py
# Formats the specs with the repo's prettier config afterwards (needs `npm ci` in cdk/).
import json, os, re, subprocess
from ruamel.yaml import YAML

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RAW = json.load(open(os.path.join(ROOT, "edc/control-plane/build/openapi/control-plane-openapi.json")))
RAWP = RAW.get("paths", {})
API = os.path.join(ROOT, "cdk/api")
yaml = YAML()
yaml.preserve_quotes = True
yaml.width = 4096
yaml.indent(mapping=2, sequence=4, offset=2)


def edc_params(path):
    return re.findall(r"\{([^}]+)\}", path)


def generic_responses(rawop):
    out = {}
    for code, r in (rawop.get("responses") or {}).items():
        schema = {"type": "object"}
        try:
            s = r["content"]["application/json"]["schema"]
            if s.get("type") == "array":
                schema = {"type": "array", "items": {"type": "object"}}
        except Exception:
            pass
        out[code] = {"content": {"application/json": {"schema": schema}},
                     "description": r.get("description", "") if isinstance(r, dict) else ""}
    return out or {"200": {"content": {"application/json": {"schema": {"type": "object"}}}, "description": "OK"}}


def make_op(rawop, context, edcpath, method, auth):
    params = edc_params(edcpath)
    parameters = [{"$ref": "#/components/parameters/ConnectorId"}]
    parameters += [{"in": "path", "name": p, "required": True, "schema": {"type": "string"}} for p in params]
    for pr in rawop.get("parameters", []) or []:
        if isinstance(pr, dict) and pr.get("in") == "query":
            parameters.append({"in": "query", "name": pr.get("name"),
                               "required": pr.get("required", False), "schema": {"type": "string"}})
    op = {"description": rawop.get("description", ""),
          "operationId": rawop.get("operationId", f"{method}{edcpath}"),
          "parameters": parameters, "responses": generic_responses(rawop),
          "tags": rawop.get("tags", [])}
    if rawop.get("requestBody"):
        op["requestBody"] = {"content": {"application/json": {"schema": {"type": "object"}}}}
    if auth:
        op["x-amazon-apigateway-auth"] = {"type": "AWS_IAM"}
    op["x-amazon-apigateway-integration"] = {
        "type": "http_proxy", "httpMethod": method.upper(),
        "connectionId": "${vpcLinkId}", "connectionType": "VPC_LINK",
        "requestParameters": {f"integration.request.path.{p}": f"method.request.path.{p}"
                              for p in (["connectorId"] + params)},
        "uri": f"http://${{loadBalancerDnsName}}/{{connectorId}}/api/{context}/{edcpath.lstrip('/')}",
        "integrationTarget": "${albArn}"}
    return op


def sync(spec_name, context, auth, add_pred):
    path = os.path.join(API, f"{spec_name}.yaml")
    doc = yaml.load(open(path))
    paths = doc["paths"]
    # Only connector-scoped paths come from EDC; others (e.g. /basyx/{any+}) are ours.
    cur = {p.replace("/{connectorId}", "", 1): p for p in paths if p.startswith("/{connectorId}/")}
    removed = [full for edc, full in cur.items() if edc not in RAWP]
    for full in removed:
        del paths[full]
    added = []
    for edc in sorted(p for p in RAWP if add_pred(p) and p not in cur):
        ops = {m: make_op(o, context, edc, m, auth) for m, o in RAWP[edc].items()
               if m.lower() in ("get", "post", "put", "delete", "patch")}
        if ops:
            paths["/{connectorId}" + edc] = ops
            added.append(edc)
    with open(path, "w") as f:
        yaml.dump(doc, f)
    print(f"{spec_name}: +{len(added)} -{len(removed)} => {len(paths)} paths")


def is_dsp(p):
    return (p.startswith("/2024/") or p.startswith("/2025-") or p == "/.well-known/dspace-version"
            or p.split("/")[1] in {"catalog", "negotiations", "transfers"})


sync("management-api", "management", True, lambda p: p.startswith("/v3/") or p.startswith("/transferprocess/"))
sync("dsp-api", "protocol", False, is_dsp)
subprocess.run(["npx", "prettier", "--write", "api/management-api.yaml", "api/dsp-api.yaml"],
               cwd=os.path.join(ROOT, "cdk"), check=True)
print("DONE")
