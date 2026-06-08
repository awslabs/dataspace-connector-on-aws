// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.types

import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSortKey
import software.amazon.edc.extensions.common.ddb.EntityType

@DynamoDbBean
data class BpnGroup(
    @get:DynamoDbPartitionKey
    @get:DynamoDbAttribute("pk")
    var pk: String = EntityType.BPN_GROUP,
    @get:DynamoDbSortKey
    @get:DynamoDbAttribute("sk")
    var sk: String = "",
    @get:DynamoDbAttribute(GROUPS)
    var groups: List<String>? = null,
) {
    /** The BPN value (stored as SK). */
    val bpn: String get() = sk

    companion object {
        const val GROUPS = "groups"
    }
}
