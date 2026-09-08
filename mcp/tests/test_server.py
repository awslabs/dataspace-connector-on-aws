"""Unit tests for the Dataspace Connector MCP server (12-primitive surface).

The HTTP layer is mocked: most tool tests monkeypatch `server._api_request` to
capture the (method, path, payload) a tool produces; the HTTP-level tests
monkeypatch `server.httpx.AsyncClient` with a fake client. No network is used.
"""

import asyncio
import json

import pytest

import server


def run(coro):
    return asyncio.run(coro)


def fn(tool):
    """Resolve a possibly-decorated MCP tool to its underlying callable."""
    return getattr(tool, "fn", tool)


class Capture:
    """Async stand-in for server._api_request that records calls and returns canned data."""

    def __init__(self, responder=None):
        self.calls = []
        self.responder = responder

    async def __call__(self, method, path, payload=None, connector_id=None):
        self.calls.append(
            {"method": method, "path": path, "payload": payload, "connector_id": connector_id}
        )
        if self.responder:
            return self.responder(method, path, payload, connector_id)
        return {"ok": True}


# --- Pure helpers ---------------------------------------------------------------


def test_build_query_spec_minimal():
    spec = server._build_query_spec(0, 50, None, None, "ASC")
    assert spec["@type"] == "QuerySpec"
    assert spec["offset"] == 0 and spec["limit"] == 50
    assert spec["@context"] == {"@vocab": "https://w3id.org/edc/v0.0.1/ns/"}
    assert "filterExpression" not in spec and "sortField" not in spec


def test_build_query_spec_with_filter_and_sort():
    flt = [{"operandLeft": "state", "operator": "=", "operandRight": "STARTED"}]
    spec = server._build_query_spec(5, 10, flt, "createdAt", "DESC")
    assert spec["filterExpression"] == flt
    assert spec["sortField"] == "createdAt" and spec["sortOrder"] == "DESC"


def test_contract_request_payload_passthrough_and_context():
    perm = [{"action": "use"}]
    payload = server._contract_request_payload(
        "https://p/dsp", "offer-1", "asset-1", "BPNL1", "dataspace-protocol-http",
        perm, [], [], None,
    )
    assert payload["@type"] == "ContractRequest"
    assert payload["@context"] == server._POLICY_CONTEXT
    assert len(payload["@context"]) == 3
    pol = payload["policy"]
    assert pol["@type"] == "odrl:Offer" and pol["@id"] == "offer-1"
    assert pol["assigner"] == "BPNL1" and pol["target"] == "asset-1"
    assert pol["odrl:permission"] == perm
    assert pol["odrl:prohibition"] == [] and pol["odrl:obligation"] == []


def test_contract_request_payload_omits_none_rules():
    payload = server._contract_request_payload(
        "https://p/dsp", "o", "a", "BPNL1", "dataspace-protocol-http", None, None, None, None,
    )
    pol = payload["policy"]
    assert "odrl:permission" not in pol
    assert "odrl:prohibition" not in pol
    assert "odrl:obligation" not in pol


def test_status_hint_maps_codes():
    assert "not found" in server._status_hint(404, "").lower()
    assert "referenced" in server._status_hint(409, "").lower()
    assert "policy" in server._status_hint(400, "Policy not equal to offer").lower()
    assert "state" in server._status_hint(400, "some other error").lower()
    assert "public/" in server._status_hint(403, "")
    assert server._status_hint(500, "") is None


def test_get_headers_api_key(monkeypatch):
    monkeypatch.setattr(server, "EDC_API_KEY", "")
    assert "X-Api-Key" not in server.get_headers()
    monkeypatch.setattr(server, "EDC_API_KEY", "secret")
    assert server.get_headers()["X-Api-Key"] == "secret"


def test_sign_request_noop_without_iam(monkeypatch):
    monkeypatch.setattr(server, "USE_AWS_IAM", False)
    headers = {"Content-Type": "application/json"}
    assert server.sign_request("GET", "http://x", headers) == headers


def test_resource_maps():
    assert set(server._RESOURCE_PATH) == {
        "assets", "policy_definitions", "contract_definitions",
        "contract_negotiations", "contract_agreements", "transfer_processes",
    }
    assert server._RESOURCE_PATH["policy_definitions"] == "policydefinitions"
    assert server._DELETABLE == {"assets", "policy_definitions", "contract_definitions"}


def test_resolve_management_url_single_connector():
    assert server._resolve_management_url(None) == "http://test.local/management"


def test_resolve_management_url_multi_appends_connector(monkeypatch):
    monkeypatch.setattr(server, "MULTI_CONNECTOR", True)
    monkeypatch.setattr(server, "_ENV_MANAGEMENT_URL", "http://ov/management/")
    assert server._resolve_management_url("carbonex") == "http://ov/management/carbonex"


def test_resolve_management_url_multi_requires_connector(monkeypatch):
    monkeypatch.setattr(server, "MULTI_CONNECTOR", True)
    with pytest.raises(ValueError):
        server._resolve_management_url(None)


# --- Generic resource primitives: path + payload mapping ------------------------


@pytest.mark.parametrize(
    "rtype,seg",
    [
        ("assets", "assets"),
        ("policy_definitions", "policydefinitions"),
        ("contract_definitions", "contractdefinitions"),
        ("contract_negotiations", "contractnegotiations"),
        ("contract_agreements", "contractagreements"),
        ("transfer_processes", "transferprocesses"),
    ],
)
def test_query_resources_maps_to_request_endpoint(monkeypatch, rtype, seg):
    cap = Capture()
    monkeypatch.setattr(server, "_api_request", cap)
    run(fn(server.query_resources)(resource_type=rtype, connector_id="c", limit=7, offset=2))
    call = cap.calls[0]
    assert call["method"] == "POST" and call["path"] == f"/v3/{seg}/request"
    assert call["payload"]["limit"] == 7 and call["payload"]["offset"] == 2


def test_get_resource_maps_and_edr(monkeypatch):
    cap = Capture()
    monkeypatch.setattr(server, "_api_request", cap)
    run(fn(server.get_resource)(resource_type="contract_negotiations", resource_id="n1", connector_id="c"))
    run(fn(server.get_resource)(resource_type="edr", resource_id="tp1", connector_id="c"))
    assert cap.calls[0]["method"] == "GET"
    assert cap.calls[0]["path"] == "/v3/contractnegotiations/n1"
    assert cap.calls[1]["path"] == "/v3/edrs/tp1/dataaddress"


def test_delete_resource_deletable(monkeypatch):
    cap = Capture(lambda *a, **k: {"success": True, "status": 204})
    monkeypatch.setattr(server, "_api_request", cap)
    out = run(fn(server.delete_resource)(resource_type="assets", resource_id="a1", connector_id="c"))
    assert cap.calls[0]["method"] == "DELETE" and cap.calls[0]["path"] == "/v3/assets/a1"
    assert out["success"] is True and out["resource_id"] == "a1"


def test_delete_resource_rejects_non_deletable(monkeypatch):
    cap = Capture()
    monkeypatch.setattr(server, "_api_request", cap)
    out = run(fn(server.delete_resource)(resource_type="transfer_processes", resource_id="x", connector_id="c"))
    assert out["error"] is True
    assert cap.calls == []


# --- Create / consumer payload shapes -------------------------------------------


def test_create_asset_wraps_data_address(monkeypatch):
    cap = Capture()
    monkeypatch.setattr(server, "_api_request", cap)
    run(fn(server.create_asset)(
        asset_id="a1",
        properties={"name": "x"},
        data_address={"type": "AmazonS3", "bucketName": "b", "objectName": "o"},
        connector_id="c",
    ))
    p = cap.calls[0]["payload"]
    assert cap.calls[0]["path"] == "/v3/assets"
    assert p["@id"] == "a1" and p["@type"] == "Asset"
    assert p["dataAddress"]["@type"] == "DataAddress"
    assert p["dataAddress"]["type"] == "AmazonS3" and p["dataAddress"]["objectName"] == "o"


def test_create_policy_context(monkeypatch):
    cap = Capture()
    monkeypatch.setattr(server, "_api_request", cap)
    run(fn(server.create_policy)(policy_id="p1", policy={"@type": "Set", "permission": []}, connector_id="c"))
    p = cap.calls[0]["payload"]
    assert cap.calls[0]["path"] == "/v3/policydefinitions"
    assert p["@context"] == server._POLICY_CONTEXT
    assert p["@type"] == "PolicyDefinition"


def test_initiate_transfer_defaults_httpproxy(monkeypatch):
    cap = Capture()
    monkeypatch.setattr(server, "_api_request", cap)
    run(fn(server.initiate_transfer)(
        counter_party_address="https://p/dsp", contract_id="agr1",
        transfer_type="HttpData-PULL", connector_id="c",
    ))
    p = cap.calls[0]["payload"]
    assert cap.calls[0]["path"] == "/v3/transferprocesses"
    assert p["dataDestination"] == {"@type": "DataAddress", "type": "HttpProxy"}
    assert p["transferType"] == "HttpData-PULL"


def test_request_catalog_body(monkeypatch):
    cap = Capture()
    monkeypatch.setattr(server, "_api_request", cap)
    run(fn(server.request_catalog)(
        counter_party_address="https://p/dsp", counter_party_id="BPNL1", connector_id="c",
    ))
    p = cap.calls[0]["payload"]
    assert cap.calls[0]["path"] == "/v3/catalog/request"
    assert p["@type"] == "CatalogRequest" and p["counterPartyId"] == "BPNL1"


# --- manage_transfer ------------------------------------------------------------


def test_manage_transfer_suspend_sends_reason(monkeypatch):
    cap = Capture(lambda *a, **k: {"success": True, "status": 204})
    monkeypatch.setattr(server, "_api_request", cap)
    out = run(fn(server.manage_transfer)(transfer_process_id="tp1", action="suspend", reason="pause", connector_id="c"))
    assert cap.calls[0]["path"] == "/v3/transferprocesses/tp1/suspend"
    assert cap.calls[0]["payload"]["reason"] == "pause"
    assert out["success"] is True and out["resulting_state"] == "SUSPENDING"


def test_manage_transfer_resume_no_body(monkeypatch):
    cap = Capture(lambda *a, **k: {"success": True, "status": 204})
    monkeypatch.setattr(server, "_api_request", cap)
    run(fn(server.manage_transfer)(transfer_process_id="tp1", action="resume", connector_id="c"))
    assert cap.calls[0]["path"] == "/v3/transferprocesses/tp1/resume"
    assert cap.calls[0]["payload"] is None


def test_manage_transfer_invalid_state_is_skipped(monkeypatch):
    cap = Capture(lambda *a, **k: {"error": True, "status": 400, "message": "invalid transition", "hint": "h"})
    monkeypatch.setattr(server, "_api_request", cap)
    out = run(fn(server.manage_transfer)(transfer_process_id="tp1", action="resume", connector_id="c"))
    assert out["success"] is False and out["skipped"] is True


def test_manage_transfer_all_started_batch(monkeypatch):
    def responder(method, path, payload, connector_id):
        if path.endswith("/request"):
            # all_started MUST filter server-side by the STARTED integer state code.
            assert payload.get("filterExpression") == [
                {"operandLeft": "state", "operator": "=", "operandRight": 600}
            ], payload.get("filterExpression")
            # server returns only the STARTED transfers (already filtered)
            return [
                {"@id": "tp1", "state": "STARTED"},
                {"@id": "tp2", "state": "STARTED"},
            ]
        if path.endswith("/tp1/terminate"):
            return {"success": True, "status": 204}
        if path.endswith("/tp2/terminate"):
            return {"error": True, "status": 400, "message": "bad state"}
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(server, "_api_request", Capture(responder))
    out = run(fn(server.manage_transfer)(transfer_process_id="all_started", action="terminate", connector_id="c"))
    assert out["batch"] == "all_started" and out["total"] == 2
    assert out["succeeded"] == ["tp1"]
    assert out["skipped"] and out["skipped"][0]["id"] == "tp2"


# --- HTTP layer: fake httpx -----------------------------------------------------


class FakeResponse:
    def __init__(self, status_code, json_body=None, text="", content=b"x", content_type="application/json"):
        self.status_code = status_code
        self._json = json_body
        self.text = text if text else (json.dumps(json_body) if json_body is not None else "")
        self.content = content
        self.headers = {"content-type": content_type}

    @property
    def is_success(self):
        return 200 <= self.status_code < 300

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class FakeAsyncClient:
    queue = []
    last = None

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def request(self, method, url, **kwargs):
        FakeAsyncClient.last = {"method": method, "url": url, "kwargs": kwargs}
        return FakeAsyncClient.queue.pop(0)


def test_api_request_204_returns_success(monkeypatch):
    FakeAsyncClient.queue = [FakeResponse(204, content=b"")]
    monkeypatch.setattr(server.httpx, "AsyncClient", FakeAsyncClient)
    out = run(server._api_request("POST", "/v3/transferprocesses/tp1/terminate", {"reason": "x"}))
    assert out == {"success": True, "status": 204}


def test_api_request_error_has_hint(monkeypatch):
    FakeAsyncClient.queue = [FakeResponse(409, json_body={"message": "referenced"})]
    monkeypatch.setattr(server.httpx, "AsyncClient", FakeAsyncClient)
    out = run(server._api_request("DELETE", "/v3/assets/a1"))
    assert out["error"] is True and out["status"] == 409
    assert "referenced" in out["hint"].lower()


def test_fetch_data_appends_public_and_returns_body(monkeypatch):
    async def fake_api(method, path, payload=None, connector_id=None):
        assert path == "/v3/edrs/tp1/dataaddress"
        return {"endpoint": "https://dp.example.com/data/carbonex", "authorization": "tok"}

    monkeypatch.setattr(server, "_api_request", fake_api)
    FakeAsyncClient.queue = [FakeResponse(200, json_body={"id": "test-001"})]
    monkeypatch.setattr(server.httpx, "AsyncClient", FakeAsyncClient)

    out = run(fn(server.fetch_data)(transfer_process_id="tp1", connector_id="c"))
    assert FakeAsyncClient.last["url"] == "https://dp.example.com/data/carbonex/public/"
    assert FakeAsyncClient.last["kwargs"]["headers"]["Authorization"] == "tok"
    assert out["status"] == 200 and out["body"] == {"id": "test-001"}


def test_fetch_data_403_has_hint(monkeypatch):
    async def fake_api(method, path, payload=None, connector_id=None):
        return {"endpoint": "https://dp.example.com/data/carbonex", "authorization": "tok"}

    monkeypatch.setattr(server, "_api_request", fake_api)
    FakeAsyncClient.queue = [FakeResponse(403, text="Forbidden", content_type="text/plain")]
    monkeypatch.setattr(server.httpx, "AsyncClient", FakeAsyncClient)

    out = run(fn(server.fetch_data)(transfer_process_id="tp1", connector_id="c"))
    assert out["status"] == 403
    assert "public/" in out["hint"] and "token" in out["hint"].lower()
