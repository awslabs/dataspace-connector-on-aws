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
import software.amazon.edc.extensions.common.ddb.leases.AbstractLeasableEntityDao
import software.amazon.edc.extensions.common.ddb.types.Leasable
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.common.ddb.utility.applyOffsetAndLimit
import software.amazon.edc.extensions.common.ddb.utility.extractStateValues
import software.amazon.edc.extensions.common.ddb.utility.getGenericPropertyComparator
import software.amazon.edc.extensions.common.ddb.utility.gsiStatePk
import software.amazon.edc.extensions.common.ddb.utility.keyFromPkSk
import software.amazon.edc.extensions.common.ddb.utility.queryRequestFromId
import software.amazon.edc.extensions.common.ddb.utility.queryRequestFromPk
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
        val items =
            if (stateValues != null) {
                stateValues
                    .flatMap {
                        stateIndex.query(queryRequestFromId(gsiStatePk(EntityType.POLICY_MONITOR, it))).flatMap { page ->
                            page.items()
                        }
                    }.asSequence()
            } else {
                table.query(queryRequestFromPk(EntityType.POLICY_MONITOR)).flatMap { it.items() }.asSequence()
            }
        return items
            .filterNot { hasActiveLease(it) }
            .sortedWith(querySpec.getGenericPropertyComparator())
            .map {
                acquireLease(it)
                it.toEdcPolicyMonitor()
            }.applyOffsetAndLimit(querySpec)
            .toMutableList()
    }

    override fun findByIdAndLease(id: String): StoreResult<PolicyMonitorEntry> {
        val policyMonitor = getPolicyMonitor(id) ?: return StoreResult.notFound("PolicyMonitor $id was not found!")
        return try {
            acquireLease(policyMonitor)
            StoreResult.success(policyMonitor.toEdcPolicyMonitor())
        } catch (e: IllegalStateException) {
            StoreResult.alreadyLeased("PolicyMonitor $id is already leased!")
        }
    }

    override fun save(entry: PolicyMonitorEntry) {
        val leaseId =
            if (getPolicyMonitor(entry.id) == null) {
                null
            } else {
                acquireLease(entry.id)
            }
        try {
            table.putItem(entry.toDdbPolicyMonitor(leaseId))
        } finally {
            if (leaseId != null) {
                breakLease(entry.id)
            }
        }
    }

    override fun getLeasableById(id: String): Leasable? = getPolicyMonitor(id)

    override fun updateLeaseId(leasable: Leasable) {
        table.updateItem(leasable as PolicyMonitor)
    }

    private fun getPolicyMonitor(id: String): PolicyMonitor? = table.getItem(keyFromPkSk(EntityType.POLICY_MONITOR, id))
}
