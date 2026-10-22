// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * PortalConnector custom resource: a connector's whole Cofinity-X portal
 * lifecycle, run by the CDK Provider framework (onEvent + isComplete).
 *
 * - Create: create an Identity Wallet Management technical user and register
 *   the connector with it right away; isComplete waits until the technical user
 *   is ACTIVE, writes its client secret and returns ClientId and
 *   StsOauthTokenUrl. Registering immediately links the technical user, so
 *   every failure path cleans up through the one connector delete call.
 * - Update: a changed connector URL is updated in place; a changed BPNL,
 *   environment, admin secret or technical user name creates a new
 *   registration (CloudFormation then deletes the old one). isComplete
 *   rewrites the secret.
 * - Delete: delete the connector together with its technical user. The portal
 *   refuses this while the technical user is still being created, so it runs
 *   in isComplete and waits.
 *
 * The physical id is the portal connector registration id.
 */

import {
  ConnectorRegistration,
  PortalClient,
  PortalEnvironment,
  PortalError,
  companyDid,
  didDocumentUrl,
  readAdminCredentials,
  writeSecret,
} from "./client";

export interface PortalConnectorProperties {
  readonly Environment: PortalEnvironment;
  readonly Bpnl: string;
  readonly ConnectorName: string;
  readonly ConnectorUrl: string;
  readonly TechnicalUserName: string;
  readonly AdminSecretName: string;
  readonly OauthSecretName: string;
}

export interface ResourceEvent {
  readonly RequestType: "Create" | "Update" | "Delete";
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: PortalConnectorProperties & {
    ServiceToken?: string;
  };
  readonly OldResourceProperties?: PortalConnectorProperties;
  readonly Data?: Record<string, string>;
}

interface OnEventResult {
  PhysicalResourceId: string;
  Data?: Record<string, string>;
}

interface IsCompleteResult {
  IsComplete: boolean;
  Data?: Record<string, string>;
}

/** Properties whose change needs a new registration. */
const REPLACING: (keyof PortalConnectorProperties)[] = [
  "Environment",
  "Bpnl",
  "TechnicalUserName",
  "AdminSecretName",
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Seam for tests. */
export const deps = {
  client: async (props: PortalConnectorProperties) =>
    new PortalClient(
      props.Environment,
      await readAdminCredentials(props.AdminSecretName),
    ),
  fetch: (url: string) => fetch(url),
  writeSecret,
};

export async function onEvent(event: ResourceEvent): Promise<OnEventResult> {
  const props = event.ResourceProperties;
  if (event.RequestType === "Create") return create(props);
  const physicalId = event.PhysicalResourceId!;
  if (event.RequestType === "Delete") return { PhysicalResourceId: physicalId };

  const old = event.OldResourceProperties!;
  if (REPLACING.some((key) => old[key] !== props[key])) return create(props);
  if (old.ConnectorUrl !== props.ConnectorUrl) {
    const client = await deps.client(props);
    await client.updateConnectorUrl(physicalId, props.ConnectorUrl);
  }
  return { PhysicalResourceId: physicalId };
}

export async function isComplete(
  event: ResourceEvent,
): Promise<IsCompleteResult> {
  const props = event.ResourceProperties;
  const physicalId = event.PhysicalResourceId!;
  // A failed create leaves no registration and a physical id that is no UUID.
  if (event.RequestType === "Delete" && !UUID.test(physicalId)) {
    return { IsComplete: true };
  }
  const client = await deps.client(props);

  if (event.RequestType === "Delete") {
    try {
      await client.deleteConnector(physicalId);
    } catch (err) {
      if (err instanceof PortalError && err.status === 404) {
        return { IsComplete: true };
      }
      if (
        err instanceof PortalError &&
        err.status === 409 &&
        err.body.includes("TECHNICAL_USER_CREATION_IN_PROGRESS")
      ) {
        return { IsComplete: false };
      }
      throw err;
    }
    return { IsComplete: true };
  }

  const technicalUserId =
    event.Data?.TechnicalUserId ??
    (await findTechnicalUserId(await client.listConnectors(), physicalId));
  const user = await client.getTechnicalUser(technicalUserId);
  if (user.status !== "ACTIVE" || !user.clientId || !user.secret) {
    return { IsComplete: false };
  }
  await deps.writeSecret(props.OauthSecretName, user.secret);
  return {
    IsComplete: true,
    Data: {
      TechnicalUserId: technicalUserId,
      ClientId: user.clientId,
      StsOauthTokenUrl: `${user.authenticationServiceUrl.replace(/\/+$/, "")}/oauth/token`,
    },
  };
}

async function create(
  props: PortalConnectorProperties,
): Promise<OnEventResult> {
  const client = await deps.client(props);

  const bpn = await client.companyBpn();
  if (bpn !== props.Bpnl) {
    throw new Error(
      `${props.AdminSecretName} belongs to ${bpn}, not to ${props.Bpnl}`,
    );
  }
  const did = companyDid(props.Environment, props.Bpnl);
  const didDocument = await deps.fetch(didDocumentUrl(did));
  if (!didDocument.ok) {
    throw new Error(
      `${props.Bpnl} has no wallet on the ${props.Environment} portal (${did} returned ${didDocument.status})`,
    );
  }

  const technicalUserId = await client.createTechnicalUser(
    props.TechnicalUserName,
    `EDC connector ${props.ConnectorName}, managed by CloudFormation`,
  );
  try {
    const connectorId = await client.registerConnector(
      props.ConnectorName,
      props.ConnectorUrl,
      technicalUserId,
    );
    return {
      PhysicalResourceId: connectorId,
      Data: { TechnicalUserId: technicalUserId },
    };
  } catch (err) {
    throw new Error(
      `${(err as Error).message}. Technical user ${technicalUserId} is not linked to a connector; delete it in the portal.`,
    );
  }
}

function findTechnicalUserId(
  connectors: ConnectorRegistration[],
  connectorId: string,
): string {
  const id = connectors.find((c) => c.id === connectorId)?.technicalUser?.id;
  if (!id) {
    throw new Error(`Connector ${connectorId} has no linked technical user`);
  }
  return id;
}
