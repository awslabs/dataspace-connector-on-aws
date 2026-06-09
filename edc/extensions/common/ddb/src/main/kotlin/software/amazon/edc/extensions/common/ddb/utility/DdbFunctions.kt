// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb.utility

import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.model.QueryConditional
import software.amazon.awssdk.enhanced.dynamodb.model.QueryEnhancedRequest
import org.eclipse.edc.spi.query.QuerySpec

fun keyFromId(id: String): Key = Key.builder().partitionValue(id).build()

fun keyFromNumber(value: Int): Key = Key.builder().partitionValue(value.toLong()).build()

fun keyFromPkSk(
    pk: String,
    sk: String,
): Key =
    Key
        .builder()
        .partitionValue(pk)
        .sortValue(sk)
        .build()

fun queryRequestFromId(id: String): QueryEnhancedRequest = queryRequestFromKey(keyFromId(id))

fun queryRequestFromNumber(value: Int): QueryEnhancedRequest = queryRequestFromKey(keyFromNumber(value))

fun queryRequestFromKey(key: Key): QueryEnhancedRequest =
    QueryEnhancedRequest.builder().queryConditional(QueryConditional.keyEqualTo(key)).build()

fun queryRequestFromPk(pk: String): QueryEnhancedRequest =
    QueryEnhancedRequest.builder().queryConditional(QueryConditional.keyEqualTo(keyFromId(pk))).build()

/**
 * Compute the maximum number of items to read from DynamoDB for a given QuerySpec.
 * When the query has no filter expression, we only need offset + limit items.
 * When filtering is present, we must read all items (filter is applied in-memory).
 */
fun ddbReadLimit(querySpec: QuerySpec): Int =
    if (querySpec.filterExpression.isEmpty()) {
        querySpec.offset + querySpec.limit
    } else {
        Int.MAX_VALUE
    }

/** Build a GSI state partition key: entityType#state */
fun gsiStatePk(
    entityType: String,
    state: Int,
): String = "$entityType#$state"
