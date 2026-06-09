// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IKey } from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import { RemovalPolicy } from "aws-cdk-lib";
import { Billing, TableEncryptionV2, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import {
  GSI_CORRELATION_ID,
  GSI_STATE,
  SINGLE_TABLE_PARTITION_KEY,
  SINGLE_TABLE_SORT_KEY,
} from "../config/ddb-tables";

export interface EdcDdbProps {
  readonly encryptionKey?: IKey;
  readonly removalPolicy: RemovalPolicy;
  readonly tableName: string;
}

export class EdcDdb extends Construct {
  readonly table: TableV2;

  constructor(scope: Construct, id: string, props: EdcDdbProps) {
    super(scope, id);
    const encryption = props.encryptionKey
      ? TableEncryptionV2.customerManagedKey(props.encryptionKey)
      : TableEncryptionV2.awsManagedKey();

    this.table = new TableV2(this, "Table", {
      tableName: props.tableName,
      partitionKey: SINGLE_TABLE_PARTITION_KEY,
      sortKey: SINGLE_TABLE_SORT_KEY,
      globalSecondaryIndexes: [GSI_STATE, GSI_CORRELATION_ID],
      billing: Billing.onDemand(),
      encryption: encryption,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: props.removalPolicy,
      timeToLiveAttribute: "ttl",
    });
  }
}
