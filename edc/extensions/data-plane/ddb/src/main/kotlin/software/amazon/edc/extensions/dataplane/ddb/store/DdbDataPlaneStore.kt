// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.ddb.store

import com.fasterxml.jackson.databind.ObjectMapper
import org.eclipse.edc.connector.dataplane.spi.store.DataPlaneStore
import org.eclipse.edc.spi.query.Criterion
import org.eclipse.edc.spi.query.CriterionOperatorRegistry
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
import software.amazon.edc.extensions.common.ddb.utility.toPredicate
import software.amazon.edc.extensions.dataplane.ddb.types.DataFlow
import software.amazon.edc.extensions.dataplane.ddb.types.toDdbDataFlow
import java.time.Clock
import org.eclipse.edc.connector.dataplane.spi.DataFlow as EdcDataFlow

class DdbDataPlaneStore(
    clock: Clock,
    private val criterionOperatorRegistry: CriterionOperatorRegistry,
    leaseHolder: String,
    leaseTable: DynamoDbTable<Lease>,
    private val objectMapper: ObjectMapper,
    private val table: DynamoDbTable<DataFlow>,
) : AbstractLeasableEntityDao(
        clock = clock,
        leaseHolder = leaseHolder,
        leaseTable = leaseTable,
    ),
    DataPlaneStore {
    private val stateIndex = table.index(DataFlow.GSI_STATE)

    override fun findById(id: String): EdcDataFlow? = getDataFlow(id)?.toEdcDataFlow(objectMapper)

    override fun nextNotLeased(
        max: Int,
        vararg criteria: Criterion,
    ): MutableList<EdcDataFlow> {
        val predicate = criteria.toList().toPredicate<Any>(criterionOperatorRegistry)
        val stateValues = criteria.extractStateValues()
        val items =
            if (stateValues != null) {
                stateValues
                    .flatMap { stateIndex.query(queryRequestFromId(gsiStatePk(EntityType.DATA_FLOW, it))).flatMap { page -> page.items() } }
                    .asSequence()
            } else {
                table.query(queryRequestFromPk(EntityType.DATA_FLOW)).flatMap { it.items() }.asSequence()
            }
        return items
            .filterNot { hasActiveLease(it) }
            .map { it.toEdcDataFlow(objectMapper) }
            .filter { predicate.test(it) }
            .sortedBy { it.stateTimestamp }
            .take(max)
            .onEach { acquireLease(it.id) }
            .toMutableList()
    }

    override fun findByIdAndLease(id: String): StoreResult<EdcDataFlow> {
        val dataFlow = getDataFlow(id) ?: return StoreResult.notFound("DataFlow with ID $id was not found!")
        return try {
            acquireLease(dataFlow)
            StoreResult.success(dataFlow.toEdcDataFlow(objectMapper))
        } catch (e: IllegalStateException) {
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
            table.putItem(dataFlow.toDdbDataFlow(objectMapper, leaseId))
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

    private fun getDataFlow(id: String): DataFlow? = table.getItem(keyFromPkSk(EntityType.DATA_FLOW, id))
}
