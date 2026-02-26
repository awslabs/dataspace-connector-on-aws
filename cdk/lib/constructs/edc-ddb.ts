// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IKey } from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import { RemovalPolicy } from "aws-cdk-lib";
import { Billing, TableEncryptionV2, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { EdcTableProps, DDB_TABLES } from "../config/ddb-tables";

export interface EdcDdbProps {
  readonly encryptionKey?: IKey;
  readonly removalPolicy: RemovalPolicy;
}

export class EdcDdb extends Construct {
  readonly tables: TableV2[];

  constructor(scope: Construct, id: string, props: EdcDdbProps) {
    super(scope, id);
    const encryption = props.encryptionKey
      ? TableEncryptionV2.customerManagedKey(props.encryptionKey)
      : TableEncryptionV2.awsManagedKey();
    this.tables = DDB_TABLES.map((tableProps) =>
      this.createTable(tableProps, encryption, props.removalPolicy),
    );
  }

  private createTable(
    props: EdcTableProps,
    encryption: TableEncryptionV2,
    removalPolicy: RemovalPolicy,
  ): TableV2 {
    return new TableV2(this, props.tableName, {
      tableName: props.tableName,
      partitionKey: props.partitionKey,
      sortKey: props.sortKey,
      globalSecondaryIndexes: props.globalSecondaryIndexes,
      billing: Billing.onDemand(),
      encryption: encryption,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: removalPolicy,
    });
  }
}
