// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.ddb.store

import org.eclipse.edc.connector.dataplane.spi.store.DataPlaneStore
import org.eclipse.edc.spi.query.Criterion
import org.eclipse.edc.spi.query.QuerySpec
import org.eclipse.edc.spi.query.SortOrder
import org.eclipse.edc.spi.result.StoreResult
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.edc.extensions.common.ddb.leases.AbstractLeasableEntityDao
import software.amazon.edc.extensions.common.ddb.types.Leasable
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.common.ddb.utility.applyOffsetAndLimit
import software.amazon.edc.extensions.common.ddb.utility.getGenericPropertyComparator
import software.amazon.edc.extensions.common.ddb.utility.keyFromId
import software.amazon.edc.extensions.common.ddb.utility.toScanRequest
import software.amazon.edc.extensions.dataplane.ddb.types.DataFlow
import software.amazon.edc.extensions.dataplane.ddb.types.toDdbDataFlow
import java.time.Clock
import org.eclipse.edc.connector.dataplane.spi.DataFlow as EdcDataFlow

class DdbDataPlaneStore(
    clock: Clock,
    leaseHolder: String,
    leaseTable: DynamoDbTable<Lease>,
    private val table: DynamoDbTable<DataFlow>,
) : DataPlaneStore, AbstractLeasableEntityDao(
        clock = clock,
        leaseHolder = leaseHolder,
        leaseTable = leaseTable,
    ) {
    override fun findById(id: String): EdcDataFlow? = getDataFlow(id)?.toEdcDataFlow()

    override fun nextNotLeased(
        max: Int,
        vararg criteria: Criterion,
    ): MutableList<EdcDataFlow> {
        val querySpec =
            QuerySpec.Builder.newInstance()
                .filter(criteria.toList())
                .sortField(DataFlow.STATE_TIMESTAMP)
                .sortOrder(SortOrder.ASC)
                .limit(max)
                .build()
        val request = querySpec.toScanRequest()
        return table.scan(request).items()
            .asSequence()
            .filterNot { hasLease(it.id) }
            .sortedWith(querySpec.getGenericPropertyComparator())
            .map {
                acquireLease(it)
                it.toEdcDataFlow()
            }
            .applyOffsetAndLimit(querySpec)
            .toMutableList()
    }

    override fun findByIdAndLease(id: String): StoreResult<EdcDataFlow> {
        val dataFlow = getDataFlow(id) ?: return StoreResult.notFound("DataFlow with ID $id was not found!")
        return try {
            acquireLease(dataFlow)
            StoreResult.success(dataFlow.toEdcDataFlow())
        } catch (e: IllegalStateException) {
//            log().error("DataFlow $id is already leased!", e)
            StoreResult.alreadyLeased("DataFlow $id is already leased!")
        }
    }

    override fun save(dataFlow: EdcDataFlow) {
        val leaseId =
            if (getDataFlow(dataFlow.id) == null) {
                null
            } else {
                acquireLease(dataFlow.id)
            }
        try {
            table.putItem(dataFlow.toDdbDataFlow(leaseId))
        } finally {
            if (leaseId != null) {
                breakLease(dataFlow.id)
            }
        }
    }

    override fun getLeasableById(id: String): Leasable? = getDataFlow(id)

    override fun updateLeaseId(leasable: Leasable) {
        table.updateItem(leasable as DataFlow)
    }

    private fun getDataFlow(id: String): DataFlow? = table.getItem(keyFromId(id))
}
