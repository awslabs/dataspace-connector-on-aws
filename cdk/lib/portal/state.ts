// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DynamoDB-backed store for per-connector portal integration state.
 *
 * One item per connector (pk = "CONNECTOR", sk = <connectorId>). This is
 * observed/progress state only; YAML is the desired state and the portal
 * registry stays the source of truth for whether a connector is registered.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

export type ConnectorPhase =
  | "IDENTITY_PENDING"
  | "IDENTITY_READY"
  | "REGISTERED";

export interface ConnectorState {
  connectorId: string;
  /** BPNL of the owning tenant; picks the admin credential for portal calls and cleanup. */
  orgKey: string;
  phase: ConnectorPhase;
  /** Portal-side registration id; enables exact, safe deregistration. */
  portalConnectorId?: string;
  createdAt: string;
  updatedAt: string;
}

const PK = "CONNECTOR";

const PHASE_ORDER: Record<ConnectorPhase, number> = {
  IDENTITY_PENDING: 0,
  IDENTITY_READY: 1,
  REGISTERED: 2,
};

interface StateUpdates {
  phase?: ConnectorPhase;
  orgKey?: string;
  portalConnectorId?: string;
}

/**
 * Applies updates to a connector state, never regressing the phase, and reports
 * whether anything meaningful changed so callers can skip no-op writes.
 * updatedAt advances only on a real change.
 */
export function nextState(
  current: ConnectorState,
  updates: StateUpdates,
): { state: ConnectorState; changed: boolean } {
  const phase =
    updates.phase && PHASE_ORDER[updates.phase] > PHASE_ORDER[current.phase]
      ? updates.phase
      : current.phase;
  const orgKey = updates.orgKey ?? current.orgKey;
  const portalConnectorId =
    updates.portalConnectorId ?? current.portalConnectorId;
  const changed =
    phase !== current.phase ||
    orgKey !== current.orgKey ||
    portalConnectorId !== current.portalConnectorId;
  return {
    state: {
      ...current,
      phase,
      orgKey,
      portalConnectorId,
      updatedAt: changed ? new Date().toISOString() : current.updatedAt,
    },
    changed,
  };
}

function toItem(s: ConnectorState): Record<string, unknown> {
  const item: Record<string, unknown> = {
    pk: PK,
    sk: s.connectorId,
    orgKey: s.orgKey,
    phase: s.phase,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
  if (s.portalConnectorId) item.portalConnectorId = s.portalConnectorId;
  return item;
}

function toState(item: Record<string, unknown>): ConnectorState {
  return {
    connectorId: String(item.sk),
    orgKey: item.orgKey ? String(item.orgKey) : "",
    phase: item.phase as ConnectorPhase,
    portalConnectorId: item.portalConnectorId
      ? String(item.portalConnectorId)
      : undefined,
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
  };
}

export class StateStore {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    region?: string,
  ) {
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  }

  async get(connectorId: string): Promise<ConnectorState | undefined> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: PK, sk: connectorId },
      }),
    );
    return res.Item ? toState(res.Item) : undefined;
  }

  async list(): Promise<ConnectorState[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": PK },
      }),
    );
    return (res.Items ?? []).map(toState);
  }

  async ensureRow(
    connectorId: string,
    orgKey: string,
  ): Promise<ConnectorState> {
    const existing = await this.get(connectorId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const state: ConnectorState = {
      connectorId,
      orgKey,
      phase: "IDENTITY_PENDING",
      createdAt: now,
      updatedAt: now,
    };
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: toItem(state) }),
    );
    return state;
  }

  async save(state: ConnectorState): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: toItem(state) }),
    );
  }

  async remove(connectorId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: PK, sk: connectorId },
      }),
    );
  }
}
