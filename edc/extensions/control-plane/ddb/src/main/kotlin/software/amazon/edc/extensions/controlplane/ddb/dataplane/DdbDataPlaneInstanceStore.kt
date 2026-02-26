// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.dataplane

import org.eclipse.edc.connector.dataplane.selector.spi.store.DataPlaneInstanceStore
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
import software.amazon.edc.extensions.controlplane.ddb.types.DataPlaneInstance
import software.amazon.edc.extensions.controlplane.ddb.types.toDdbDataPlaneInstance
import java.time.Clock
import java.util.stream.Stream
import kotlin.streams.asStream
import org.eclipse.edc.connector.dataplane.selector.spi.instance.DataPlaneInstance as EdcDataPlaneInstance

class DdbDataPlaneInstanceStore(
    clock: Clock,
    leaseHolder: String,
    leaseTable: DynamoDbTable<Lease>,
    private val table: DynamoDbTable<DataPlaneInstance>,
) : DataPlaneInstanceStore, AbstractLeasableEntityDao(
        clock = clock,
        leaseHolder = leaseHolder,
        leaseTable = leaseTable,
    ) {
    override fun findById(id: String): EdcDataPlaneInstance? = getDataPlaneInstance(id)?.toEdcDataPlaneInstance()

    override fun nextNotLeased(
        max: Int,
        vararg criteria: Criterion,
    ): MutableList<EdcDataPlaneInstance> {
        val querySpec =
            QuerySpec.Builder.newInstance()
                .filter(criteria.asList())
                .sortField("stateTimestamp")
                .sortOrder(SortOrder.ASC)
                .limit(max)
                .build()
        return table.scan(querySpec.toScanRequest()).items()
            .asSequence()
            .filterNot { hasLease(it.id) }
            .sortedWith(querySpec.getGenericPropertyComparator())
            .applyOffsetAndLimit(querySpec)
            .onEach { acquireLease(it) }
            .map { it.toEdcDataPlaneInstance() }
            .toMutableList()
    }

    override fun findByIdAndLease(id: String): StoreResult<EdcDataPlaneInstance> {
        val dataPlaneInstance =
            getDataPlaneInstance(id)
                ?: return StoreResult.notFound("DataPlaneInstance $id not found!")
        return try {
            acquireLease(dataPlaneInstance)
            StoreResult.success(dataPlaneInstance.toEdcDataPlaneInstance())
        } catch (e: IllegalStateException) {
            val message = "DataPlaneInstance $id is already leased!"
//            log().error(message, e)
            StoreResult.alreadyLeased(message)
        }
    }

    override fun save(dataPlaneInstance: EdcDataPlaneInstance) {
        val leaseId =
            if (getDataPlaneInstance(dataPlaneInstance.id) == null) {
                null
            } else {
                acquireLease(dataPlaneInstance.id)
            }
        try {
            table.putItem(dataPlaneInstance.toDdbDataPlaneInstance(leaseId))
        } finally {
            if (leaseId != null) {
                breakLease(dataPlaneInstance.id)
            }
        }
    }

    override fun deleteById(id: String): StoreResult<EdcDataPlaneInstance> =
        table.deleteItem(keyFromId(id))?.let { StoreResult.success(it.toEdcDataPlaneInstance()) }
            ?: StoreResult.notFound("DataPlaneInstance $id not found!")

    override fun getAll(): Stream<EdcDataPlaneInstance> = table.scan().items().asSequence().map { it.toEdcDataPlaneInstance() }.asStream()

    override fun getLeasableById(id: String): Leasable? = getDataPlaneInstance(id)

    override fun updateLeaseId(leasable: Leasable) {
        table.updateItem(leasable as DataPlaneInstance)
    }

    private fun getDataPlaneInstance(id: String): DataPlaneInstance? = table.getItem(keyFromId(id))
}
