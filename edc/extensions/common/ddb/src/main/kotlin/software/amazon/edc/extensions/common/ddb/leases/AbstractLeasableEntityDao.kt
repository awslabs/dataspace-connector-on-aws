// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb.leases

import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Expression
import software.amazon.awssdk.enhanced.dynamodb.model.PutItemEnhancedRequest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.edc.extensions.common.ddb.EntityType
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.common.ddb.utility.keyFromPkSk
import software.amazon.edc.extensions.common.ddb.utility.queryRequestFromPk
import java.time.Clock
import java.time.Duration

/**
 * Lease management for state-machine entities, decoupled from the entity item.
 *
 * A lease is a single small [Lease] item keyed by the entity id ([EntityType.LEASE], sk = entityId).
 * Acquiring is an atomic conditional put (succeeds only if there is no lease, it is expired, or it is
 * already held by this holder); releasing is a delete. Neither touches the entity item, so lease churn
 * no longer rewrites the entity or its gsi-state index — the dominant historical write-cost driver.
 */
abstract class AbstractLeasableEntityDao(
    private val clock: Clock,
    private val leaseDuration: Duration = Duration.ofMillis(60000),
    private val leaseHolder: String,
    private val leaseTable: DynamoDbTable<Lease>,
) {
    /**
     * Atomically acquire the lease for [entityId]. Throws [IllegalStateException] if it is currently
     * held by another holder and not yet expired.
     */
    fun acquireLease(
        entityId: String,
        leaseHolder: String = this.leaseHolder,
        duration: Duration = leaseDuration,
    ) {
        val now = clock.millis()
        val lease =
            Lease(
                pk = EntityType.LEASE,
                sk = entityId,
                leasedAt = now,
                leasedBy = leaseHolder,
                leaseDuration = duration.toMillis(),
            ).withExpiry()
        val condition =
            Expression
                .builder()
                .expression("attribute_not_exists(sk) OR expiresAt < :now OR leasedBy = :holder")
                .putExpressionValue(":now", AttributeValue.builder().n(now.toString()).build())
                .putExpressionValue(":holder", AttributeValue.builder().s(leaseHolder).build())
                .build()
        try {
            leaseTable.putItem(
                PutItemEnhancedRequest
                    .builder(Lease::class.java)
                    .item(lease)
                    .conditionExpression(condition)
                    .build(),
            )
        } catch (e: ConditionalCheckFailedException) {
            throw IllegalStateException("Entity $entityId is currently leased!")
        }
    }

    /** Release the lease for [entityId] (no-op if none). */
    fun breakLease(entityId: String) {
        leaseTable.deleteItem(keyFromPkSk(EntityType.LEASE, entityId))
    }

    /** True if [entityId] currently holds a non-expired lease. */
    fun hasLease(entityId: String): Boolean {
        val lease = getLease(entityId) ?: return false
        return !lease.isExpired(clock)
    }

    /** True if a non-expired lease on [entityId] is held by a holder other than [leaseHolder]. */
    protected fun isLeasedByAnother(entityId: String): Boolean {
        val lease = getLease(entityId) ?: return false
        return !lease.isExpired(clock) && lease.leasedBy != leaseHolder
    }

    fun isLeasedBy(
        entityId: String,
        leaseHolder: String = this.leaseHolder,
    ): Boolean {
        val lease = getLease(entityId) ?: return false
        return !lease.isExpired(clock) && lease.leasedBy == leaseHolder
    }

    /**
     * One-query snapshot of the entity ids that currently hold a non-expired lease, via a single Query on
     * the Lease partition. Lets the nextNotLeased implementations filter leased candidates in memory instead
     * of a getItem per candidate. The atomic conditional acquire remains the concurrency guard, so a
     * momentarily stale snapshot can never cause double-processing.
     */
    protected fun activeLeaseIds(): Set<String> {
        val now = clock.millis()
        return leaseTable
            .query(queryRequestFromPk(EntityType.LEASE))
            .flatMap { it.items() }
            .asSequence()
            .filter { it.expiresAt >= now }
            .map { it.entityId }
            .toSet()
    }

    private fun getLease(entityId: String): Lease? = leaseTable.getItem(keyFromPkSk(EntityType.LEASE, entityId))
}
