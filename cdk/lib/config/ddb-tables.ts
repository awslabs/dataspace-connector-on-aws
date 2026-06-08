// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  AttributeType,
  GlobalSecondaryIndexPropsV2,
} from "aws-cdk-lib/aws-dynamodb";

export const EDC_DDB_TABLE_NAME_ENV_VAR = "edc.ddb.table.name";

export const SINGLE_TABLE_PARTITION_KEY = {
  name: "pk",
  type: AttributeType.STRING,
};

export const SINGLE_TABLE_SORT_KEY = {
  name: "sk",
  type: AttributeType.STRING,
};

export const GSI_STATE: GlobalSecondaryIndexPropsV2 = {
  indexName: "gsi-state",
  partitionKey: {
    name: "gsiStatePk",
    type: AttributeType.STRING,
  },
  sortKey: {
    name: "stateTimestamp",
    type: AttributeType.NUMBER,
  },
};

export const GSI_CORRELATION_ID: GlobalSecondaryIndexPropsV2 = {
  indexName: "gsi-correlationId",
  partitionKey: {
    name: "correlationId",
    type: AttributeType.STRING,
  },
  sortKey: {
    name: "pk",
    type: AttributeType.STRING,
  },
};
