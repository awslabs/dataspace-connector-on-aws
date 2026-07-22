// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from "constructs";
import { RemovalPolicy } from "aws-cdk-lib";
import {
  AttributeType,
  Billing,
  GlobalSecondaryIndexPropsV2,
  TableEncryptionV2,
  TableV2,
} from "aws-cdk-lib/aws-dynamodb";

// EDC single-table design: one table per connector, keyed by pk/sk with two GSIs.
const PARTITION_KEY = { name: "pk", type: AttributeType.STRING };
const SORT_KEY = { name: "sk", type: AttributeType.STRING };

const GSI_STATE: GlobalSecondaryIndexPropsV2 = {
  indexName: "gsi-state",
  partitionKey: { name: "gsiStatePk", type: AttributeType.STRING },
  sortKey: { name: "stateTimestamp", type: AttributeType.NUMBER },
};

const GSI_CORRELATION_ID: GlobalSecondaryIndexPropsV2 = {
  indexName: "gsi-correlationId",
  partitionKey: { name: "correlationId", type: AttributeType.STRING },
  sortKey: { name: "pk", type: AttributeType.STRING },
};

export interface EdcDdbProps {
  readonly removalPolicy: RemovalPolicy;
  readonly tableName: string;
}

export class EdcDdb extends Construct {
  readonly table: TableV2;

  constructor(scope: Construct, id: string, props: EdcDdbProps) {
    super(scope, id);

    this.table = new TableV2(this, "Table", {
      tableName: props.tableName,
      partitionKey: PARTITION_KEY,
      sortKey: SORT_KEY,
      globalSecondaryIndexes: [GSI_STATE, GSI_CORRELATION_ID],
      billing: Billing.onDemand(),
      encryption: TableEncryptionV2.awsManagedKey(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: props.removalPolicy,
      timeToLiveAttribute: "ttl",
    });
  }
}
