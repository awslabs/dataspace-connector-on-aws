// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Attribute,
  AttributeType,
  GlobalSecondaryIndexPropsV2,
} from "aws-cdk-lib/aws-dynamodb";

export interface EdcTableProps {
  readonly tableName: string;
  readonly partitionKey: Attribute;
  readonly sortKey?: Attribute;
  readonly globalSecondaryIndexes?: GlobalSecondaryIndexPropsV2[];
}

const ID = "id";
const COMMON_PARTITION_KEY: Attribute = {
  name: ID,
  type: AttributeType.STRING,
};
const INDEX_CORRELATION_ID: GlobalSecondaryIndexPropsV2 = {
  indexName: "index-correlationId",
  partitionKey: {
    name: "correlationId",
    type: AttributeType.STRING,
  },
};
const INDEX_STATE: GlobalSecondaryIndexPropsV2 = {
  indexName: "index-state",
  partitionKey: {
    name: "state",
    type: AttributeType.NUMBER,
  },
};

export const DDB_TABLES: EdcTableProps[] = [
  {
    tableName: "AccessTokens",
    partitionKey: COMMON_PARTITION_KEY,
  },
  {
    tableName: "Assets",
    partitionKey: COMMON_PARTITION_KEY,
  },
  {
    tableName: "BusinessPartnerGroups",
    partitionKey: COMMON_PARTITION_KEY,
  },
  {
    tableName: "ContractAgreements",
    partitionKey: COMMON_PARTITION_KEY,
  },
  {
    tableName: "ContractDefinitions",
    partitionKey: COMMON_PARTITION_KEY,
  },
  {
    tableName: "ContractNegotiations",
    partitionKey: COMMON_PARTITION_KEY,
    globalSecondaryIndexes: [INDEX_CORRELATION_ID, INDEX_STATE],
  },
  {
    tableName: "DataFlows",
    partitionKey: COMMON_PARTITION_KEY,
    globalSecondaryIndexes: [INDEX_STATE],
  },
  {
    tableName: "DataPlaneInstances",
    partitionKey: COMMON_PARTITION_KEY,
    globalSecondaryIndexes: [INDEX_STATE],
  },
  {
    tableName: "EdrEntries",
    partitionKey: COMMON_PARTITION_KEY,
  },
  {
    tableName: "Leases",
    partitionKey: COMMON_PARTITION_KEY,
  },
  {
    tableName: "PolicyDefinitions",
    partitionKey: COMMON_PARTITION_KEY,
  },
  {
    tableName: "PolicyMonitors",
    partitionKey: COMMON_PARTITION_KEY,
    globalSecondaryIndexes: [INDEX_STATE],
  },
  {
    tableName: "TransferProcesses",
    partitionKey: COMMON_PARTITION_KEY,
    globalSecondaryIndexes: [INDEX_CORRELATION_ID, INDEX_STATE],
  },
];
