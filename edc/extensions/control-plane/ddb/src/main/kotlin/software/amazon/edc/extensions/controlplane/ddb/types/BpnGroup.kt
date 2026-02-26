// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.types

import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey

@DynamoDbBean
data class BpnGroup(
    @get:DynamoDbAttribute(BPN)
    @get:DynamoDbPartitionKey
    var bpn: String = "",
    @get:DynamoDbAttribute(GROUPS)
    var groups: List<String>? = null,
) {
    companion object {
        const val BPN = "bpn"
        const val GROUPS = "groups"

        const val TABLE_NAME = "BusinessPartnerGroups"
    }
}
