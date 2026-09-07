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

/**
 * Lease record for state-machine entities. Keyed by the leased entity's id (sk), so a lease is a
 * single small item decoupled from the entity itself: acquiring or releasing a lease never rewrites
 * the entity (and therefore never touches the entity's gsi-state index). [expiresAt] is stored so the
 * atomic conditional acquire can compare against it (DynamoDB condition expressions cannot do arithmetic).
 */
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
    @get:DynamoDbAttribute(EXPIRES_AT)
    var expiresAt: Long = 0L,
    @get:DynamoDbAttribute("ttl")
    var ttl: Long? = null,
) {
    /** The leased entity's id (this lease's sort key). */
    val entityId: String get() = sk

    fun isExpired(clock: Clock): Boolean = expiresAt < clock.millis()

    /** Populate [expiresAt] and the DynamoDB [ttl] (epoch seconds + buffer) from leasedAt + duration. */
    fun withExpiry(): Lease {
        val expiry = leasedAt + leaseDuration
        return copy(expiresAt = expiry, ttl = expiry / 1000 + TTL_BUFFER_SECONDS)
    }

    companion object {
        const val LEASED_AT = "leasedAt"
        const val LEASED_BY = "leasedBy"
        const val LEASE_DURATION = "leaseDuration"
        const val EXPIRES_AT = "expiresAt"
    }
}
