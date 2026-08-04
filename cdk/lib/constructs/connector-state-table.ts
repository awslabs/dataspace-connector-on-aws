// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from "constructs";
import { RemovalPolicy } from "aws-cdk-lib";
import {
  AttributeType,
  Billing,
  TableEncryptionV2,
  TableV2,
} from "aws-cdk-lib/aws-dynamodb";

// Cross-run portal integration state, read and written by provision and finalize.
// One item per connector:
//   pk = "CONNECTOR", sk = <connectorId>
//   { orgKey, phase, portalConnectorId, createdAt, updatedAt }
// Observed/progress state only. YAML is the desired state and the portal
// registry stays the source of truth for whether a connector is registered.
const PARTITION_KEY = { name: "pk", type: AttributeType.STRING };
const SORT_KEY = { name: "sk", type: AttributeType.STRING };

export class ConnectorStateTable extends Construct {
  readonly table: TableV2;

  constructor(scope: Construct, id: string, tableName: string) {
    super(scope, id);

    this.table = new TableV2(this, "Table", {
      tableName,
      partitionKey: PARTITION_KEY,
      sortKey: SORT_KEY,
      billing: Billing.onDemand(),
      encryption: TableEncryptionV2.awsManagedKey(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
