// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb.utility

import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.model.QueryConditional
import software.amazon.awssdk.enhanced.dynamodb.model.QueryEnhancedRequest

fun keyFromId(id: String): Key = Key.builder().partitionValue(id).build()

fun queryRequestFromId(id: String): QueryEnhancedRequest = queryRequestFromKey(keyFromId(id))

fun queryRequestFromKey(key: Key): QueryEnhancedRequest =
    QueryEnhancedRequest.builder().queryConditional(QueryConditional.keyEqualTo(key)).build()
