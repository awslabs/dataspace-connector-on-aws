// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb.leases

import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.edc.extensions.common.ddb.types.Leasable
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.common.ddb.utility.keyFromId
import java.time.Clock
import java.time.Duration
import java.util.UUID

abstract class AbstractLeasableEntityDao(
    private val clock: Clock,
    private val leaseDuration: Duration = Duration.ofMillis(60000),
    private val leaseHolder: String,
    private val leaseTable: DynamoDbTable<Lease>,
) {
    abstract fun getLeasableById(id: String): Leasable?

    abstract fun updateLeaseId(leasable: Leasable)

    protected fun breakLease(entityId: String) {
        val leasable = getLeasableById(entityId) ?: return
        breakLease(leasable)
    }

    private fun breakLease(leasable: Leasable) {
        val leaseId = leasable.leaseId ?: return
        val lease = getLease(leaseId) ?: return

        leasable.leaseId = null
        updateLeaseId(leasable)
        leaseTable.deleteItem(lease)
    }

    fun acquireLease(
        entityId: String,
        leaseHolder: String = this.leaseHolder,
        duration: Duration = leaseDuration,
    ): String {
        val leasable =
            getLeasableById(entityId)
                ?: throw IllegalArgumentException("Entity with ID $entityId not found!")
        return acquireLease(leasable, leaseHolder, duration)
    }

    protected fun acquireLease(
        leasable: Leasable,
        leaseHolder: String = this.leaseHolder,
        duration: Duration = leaseDuration,
    ): String {
        val now = clock.millis()
        val leaseId = leasable.leaseId
        val lease = if (leaseId == null) null else getLease(leaseId)

        if (lease != null) {
            if (lease.isExpired(clock) || lease.leasedBy == leaseHolder) {
                leaseTable.deleteItem(lease)
            } else {
                throw IllegalStateException("Entity is currently leased!")
            }
        }

        val id = UUID.randomUUID().toString()
        leasable.leaseId = id
        updateLeaseId(leasable)
        leaseTable.putItem(
            Lease(
                leaseId = id,
                leasedAt = now,
                leasedBy = leaseHolder,
                leaseDuration = duration.toMillis(),
            ),
        )
        return id
    }

    protected fun hasLease(entityId: String): Boolean {
        val leasable = getLeasableById(entityId) ?: return false
        val leaseId = leasable.leaseId ?: return false
        val lease = getLease(leaseId) ?: return false
        return if (lease.isExpired(clock)) {
            leaseTable.deleteItem(lease)
            false
        } else {
            true
        }
    }

    fun isLeasedBy(
        entityId: String,
        leaseHolder: String = this.leaseHolder,
    ): Boolean {
        val leasable = getLeasableById(entityId) ?: return false
        val leaseId = leasable.leaseId ?: return false
        val lease = getLease(leaseId) ?: return false
        return !lease.isExpired(clock) && lease.leasedBy == leaseHolder
    }

    private fun getLease(id: String): Lease? = leaseTable.getItem(keyFromId(id))
}
