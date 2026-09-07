// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.policies

import org.eclipse.edc.connector.policy.monitor.spi.PolicyMonitorEntry
import org.eclipse.edc.connector.policy.monitor.spi.PolicyMonitorStore
import org.eclipse.edc.spi.query.Criterion
import org.eclipse.edc.spi.query.QuerySpec
import org.eclipse.edc.spi.query.SortOrder
import org.eclipse.edc.spi.result.StoreResult
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.edc.extensions.common.ddb.EntityType
import software.amazon.edc.extensions.common.ddb.STATE_INDEX_CACHE_TTL_MILLIS
import software.amazon.edc.extensions.common.ddb.leases.AbstractLeasableEntityDao
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.common.ddb.utility.IterationCache
import software.amazon.edc.extensions.common.ddb.utility.applyOffsetAndLimit
import software.amazon.edc.extensions.common.ddb.utility.extractStateValues
import software.amazon.edc.extensions.common.ddb.utility.getGenericPropertyComparator
import software.amazon.edc.extensions.common.ddb.utility.keyFromPkSk
import software.amazon.edc.extensions.common.ddb.utility.queryRequestFromId
import software.amazon.edc.extensions.controlplane.ddb.types.PolicyMonitor
import software.amazon.edc.extensions.controlplane.ddb.types.toDdbPolicyMonitor
import java.time.Clock

class DdbPolicyMonitorStore(
    clock: Clock,
    leaseHolder: String,
    leaseTable: DynamoDbTable<Lease>,
    private val table: DynamoDbTable<PolicyMonitor>,
) : AbstractLeasableEntityDao(
        clock = clock,
        leaseHolder = leaseHolder,
        leaseTable = leaseTable,
    ),
    PolicyMonitorStore {
    private val stateIndex = table.index(PolicyMonitor.GSI_STATE)
    private val stateCache = IterationCache<PolicyMonitor>(STATE_INDEX_CACHE_TTL_MILLIS)

    override fun findById(id: String): PolicyMonitorEntry? = getPolicyMonitor(id)?.toEdcPolicyMonitor()

    override fun nextNotLeased(
        max: Int,
        vararg criteria: Criterion,
    ): MutableList<PolicyMonitorEntry> {
        val querySpec =
            QuerySpec.Builder
                .newInstance()
                .filter(criteria.toList())
                .sortField("stateTimestamp")
                .sortOrder(SortOrder.ASC)
                .limit(max)
                .build()
        val stateValues = criteria.extractStateValues()
        val indexed =
            stateCache.getOrLoad {
                stateIndex.query(queryRequestFromId(EntityType.POLICY_MONITOR)).flatMap { it.items() }
            }
        val items =
            if (stateValues != null) {
                indexed.asSequence().filter { it.state in stateValues }
            } else {
                indexed.asSequence()
            }
        val leased = activeLeaseIds()
        return items
            .filterNot { it.sk in leased }
            .sortedWith(querySpec.getGenericPropertyComparator())
            .map {
                acquireLease(it.sk)
                it.toEdcPolicyMonitor()
            }.applyOffsetAndLimit(querySpec)
            .toMutableList()
    }

    override fun findByIdAndLease(id: String): StoreResult<PolicyMonitorEntry> {
        val policyMonitor = getPolicyMonitor(id) ?: return StoreResult.notFound("PolicyMonitor $id was not found!")
        return try {
            acquireLease(policyMonitor.sk)
            StoreResult.success(policyMonitor.toEdcPolicyMonitor())
        } catch (e: IllegalStateException) {
            StoreResult.alreadyLeased("PolicyMonitor $id is already leased!")
        }
    }

    override fun save(entry: PolicyMonitorEntry): StoreResult<Void> {
        val incoming = entry.toDdbPolicyMonitor()
        val current = getPolicyMonitor(entry.id)
        // Unchanged — skip the entity+GSI write; still release the lease (EDC save-releases-lease contract).
        if (current != null && current == incoming.copy(updatedAt = current.updatedAt)) {
            breakLease(entry.id)
            return StoreResult.success()
        }
        if (current != null) {
            try {
                acquireLease(entry.id)
            } catch (e: IllegalStateException) {
                return StoreResult.alreadyLeased("PolicyMonitor ${entry.id} is already leased!")
            }
        }
        table.putItem(incoming)
        if (current != null) {
            breakLease(entry.id)
        }
        stateCache.invalidate()
        return StoreResult.success()
    }

    private fun getPolicyMonitor(id: String): PolicyMonitor? = table.getItem(keyFromPkSk(EntityType.POLICY_MONITOR, id))
}
