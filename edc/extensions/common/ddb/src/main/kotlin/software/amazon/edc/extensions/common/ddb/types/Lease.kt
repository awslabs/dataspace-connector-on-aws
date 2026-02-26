// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb.types

import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import java.time.Clock

@DynamoDbBean
data class Lease(
    @get:DynamoDbAttribute(ID)
    @get:DynamoDbPartitionKey
    var leaseId: String = "",
    @get:DynamoDbAttribute(LEASED_AT)
    var leasedAt: Long = 0L,
    @get:DynamoDbAttribute(LEASED_BY)
    var leasedBy: String = "",
    @get:DynamoDbAttribute(LEASE_DURATION)
    var leaseDuration: Long = 60000,
) {
    fun isExpired(clock: Clock): Boolean = leasedAt + leaseDuration < clock.millis()

    companion object {
        const val ID = "id"
        const val LEASED_AT = "leasedAt"
        const val LEASED_BY = "leasedBy"
        const val LEASE_DURATION = "leaseDuration"

        const val TABLE_NAME = "Leases"
    }
}
