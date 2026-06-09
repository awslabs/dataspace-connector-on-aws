// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb.types

import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSortKey
import software.amazon.edc.extensions.common.ddb.EntityType
import software.amazon.edc.extensions.common.ddb.TTL_BUFFER_SECONDS
import java.time.Clock

@DynamoDbBean
data class Lease(
    @get:DynamoDbPartitionKey
    @get:DynamoDbAttribute("pk")
    var pk: String = EntityType.LEASE,
    @get:DynamoDbSortKey
    @get:DynamoDbAttribute("sk")
    var sk: String = "",
    @get:DynamoDbAttribute(LEASED_AT)
    var leasedAt: Long = 0L,
    @get:DynamoDbAttribute(LEASED_BY)
    var leasedBy: String = "",
    @get:DynamoDbAttribute(LEASE_DURATION)
    var leaseDuration: Long = 60000,
    @get:DynamoDbAttribute("ttl")
    var ttl: Long? = null,
) {
    val leaseId: String get() = sk

    fun isExpired(clock: Clock): Boolean = leasedAt + leaseDuration < clock.millis()

    /** Compute TTL: lease expiry + buffer, in epoch seconds */
    fun withTtl(): Lease = copy(ttl = (leasedAt + leaseDuration) / 1000 + TTL_BUFFER_SECONDS)

    companion object {
        const val LEASED_AT = "leasedAt"
        const val LEASED_BY = "leasedBy"
        const val LEASE_DURATION = "leaseDuration"
    }
}
