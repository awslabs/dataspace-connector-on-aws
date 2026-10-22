// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PortalClient, PortalError } from "../lib/portal-connector/client";
import {
  PortalConnectorProperties,
  ResourceEvent,
  deps,
  isComplete,
  onEvent,
} from "../lib/portal-connector/handler";

const CONNECTOR_ID = "11111111-2222-3333-4444-555555555555";
const props: PortalConnectorProperties = {
  Environment: "beta",
  Bpnl: "BPNL00000007J65N",
  ConnectorName: "alpha",
  ConnectorUrl: "https://dsp/alpha",
  TechnicalUserName: "dep-alpha",
  AdminSecretName: "dep/portal-admin/BPNL00000007J65N",
  OauthSecretName: "dep/alpha/edc.iam.sts.oauth.client.secret",
};

type Client = Record<
  | "companyBpn"
  | "createTechnicalUser"
  | "getTechnicalUser"
  | "registerConnector"
  | "listConnectors"
  | "updateConnectorUrl"
  | "deleteConnector",
  jest.Mock
>;

let client: Client;
let writeSecret: jest.Mock;
let fetchDid: jest.Mock;

beforeEach(() => {
  client = {
    companyBpn: jest.fn(async () => props.Bpnl),
    createTechnicalUser: jest.fn(async () => "tu-1"),
    getTechnicalUser: jest.fn(async () => ({
      serviceAccountId: "tu-1",
      clientId: "client-1",
      secret: "s3cret",
      status: "ACTIVE",
      authenticationServiceUrl: "https://auth.example/",
    })),
    registerConnector: jest.fn(async () => CONNECTOR_ID),
    listConnectors: jest.fn(async () => [
      {
        id: CONNECTOR_ID,
        name: "alpha",
        connectorUrl: "",
        technicalUser: { id: "tu-1" },
      },
    ]),
    updateConnectorUrl: jest.fn(async () => {}),
    deleteConnector: jest.fn(async () => {}),
  };
  writeSecret = jest.fn(async () => {});
  fetchDid = jest.fn(async () => ({ ok: true, status: 200 }));
  deps.client = async () => client as unknown as PortalClient;
  deps.writeSecret = writeSecret;
  deps.fetch = fetchDid as unknown as typeof deps.fetch;
});

const event = (e: Partial<ResourceEvent>): ResourceEvent => ({
  RequestType: "Create",
  ResourceProperties: props,
  ...e,
});

describe("onEvent", () => {
  test("create: technical user, then the registration linked to it", async () => {
    const result = await onEvent(event({}));
    expect(client.createTechnicalUser).toHaveBeenCalledWith(
      "dep-alpha",
      expect.any(String),
    );
    expect(client.registerConnector).toHaveBeenCalledWith(
      "alpha",
      "https://dsp/alpha",
      "tu-1",
    );
    expect(fetchDid).toHaveBeenCalledWith(
      "https://portal-backend.beta.cofinity-x.com/api/administration/staticdata/did/BPNL00000007J65N/did.json",
    );
    expect(result).toEqual({
      PhysicalResourceId: CONNECTOR_ID,
      Data: { TechnicalUserId: "tu-1" },
    });
  });

  test("create: an admin secret of another company is refused", async () => {
    client.companyBpn.mockResolvedValue("BPNL00000000OTHR");
    await expect(onEvent(event({}))).rejects.toThrow(/belongs to/);
    expect(client.createTechnicalUser).not.toHaveBeenCalled();
  });

  test("create: a BPNL without a wallet is refused", async () => {
    fetchDid.mockResolvedValue({ ok: false, status: 404 });
    await expect(onEvent(event({}))).rejects.toThrow(/no wallet/);
    expect(client.createTechnicalUser).not.toHaveBeenCalled();
  });

  test("update: a new connector URL is updated in place", async () => {
    const result = await onEvent(
      event({
        RequestType: "Update",
        PhysicalResourceId: CONNECTOR_ID,
        OldResourceProperties: { ...props, ConnectorUrl: "https://old" },
      }),
    );
    expect(client.updateConnectorUrl).toHaveBeenCalledWith(
      CONNECTOR_ID,
      "https://dsp/alpha",
    );
    expect(client.createTechnicalUser).not.toHaveBeenCalled();
    expect(result.PhysicalResourceId).toBe(CONNECTOR_ID);
  });

  test("update: a new BPNL creates a new registration", async () => {
    client.registerConnector.mockResolvedValue("new-id");
    const result = await onEvent(
      event({
        RequestType: "Update",
        PhysicalResourceId: CONNECTOR_ID,
        OldResourceProperties: { ...props, Bpnl: "BPNL00000000OLD1" },
      }),
    );
    expect(result.PhysicalResourceId).toBe("new-id");
  });

  test("delete: deferred to isComplete", async () => {
    const result = await onEvent(
      event({ RequestType: "Delete", PhysicalResourceId: CONNECTOR_ID }),
    );
    expect(result).toEqual({ PhysicalResourceId: CONNECTOR_ID });
    expect(client.deleteConnector).not.toHaveBeenCalled();
  });
});

describe("isComplete", () => {
  test("waits while the technical user is PENDING", async () => {
    client.getTechnicalUser.mockResolvedValue({
      serviceAccountId: "tu-1",
      clientId: null,
      secret: null,
      status: "PENDING",
      authenticationServiceUrl: "placeholder",
    });
    const result = await isComplete(
      event({
        PhysicalResourceId: CONNECTOR_ID,
        Data: { TechnicalUserId: "tu-1" },
      }),
    );
    expect(result).toEqual({ IsComplete: false });
    expect(writeSecret).not.toHaveBeenCalled();
  });

  test("ACTIVE: writes the secret and returns the identity attributes", async () => {
    const result = await isComplete(
      event({
        PhysicalResourceId: CONNECTOR_ID,
        Data: { TechnicalUserId: "tu-1" },
      }),
    );
    expect(writeSecret).toHaveBeenCalledWith(props.OauthSecretName, "s3cret");
    expect(result).toEqual({
      IsComplete: true,
      Data: {
        TechnicalUserId: "tu-1",
        ClientId: "client-1",
        StsOauthTokenUrl: "https://auth.example/oauth/token",
      },
    });
  });

  test("update: finds the technical user through the registration", async () => {
    await isComplete(
      event({ RequestType: "Update", PhysicalResourceId: CONNECTOR_ID }),
    );
    expect(client.getTechnicalUser).toHaveBeenCalledWith("tu-1");
  });

  test("delete: connector and technical user in one call", async () => {
    const result = await isComplete(
      event({ RequestType: "Delete", PhysicalResourceId: CONNECTOR_ID }),
    );
    expect(client.deleteConnector).toHaveBeenCalledWith(CONNECTOR_ID);
    expect(result).toEqual({ IsComplete: true });
  });

  test("delete: waits while the technical user is still being created", async () => {
    client.deleteConnector.mockRejectedValue(
      new PortalError(
        409,
        '{"errors":{"TECHNICAL_USER_CREATION_IN_PROGRESS":[]}}',
        "x",
      ),
    );
    const result = await isComplete(
      event({ RequestType: "Delete", PhysicalResourceId: CONNECTOR_ID }),
    );
    expect(result).toEqual({ IsComplete: false });
  });

  test("delete: an already deleted connector is done", async () => {
    client.deleteConnector.mockRejectedValue(new PortalError(404, "", "x"));
    const result = await isComplete(
      event({ RequestType: "Delete", PhysicalResourceId: CONNECTOR_ID }),
    );
    expect(result).toEqual({ IsComplete: true });
  });

  test("delete after a failed create: nothing to delete", async () => {
    const result = await isComplete(
      event({ RequestType: "Delete", PhysicalResourceId: "failed-create" }),
    );
    expect(result).toEqual({ IsComplete: true });
    expect(client.deleteConnector).not.toHaveBeenCalled();
  });
});
