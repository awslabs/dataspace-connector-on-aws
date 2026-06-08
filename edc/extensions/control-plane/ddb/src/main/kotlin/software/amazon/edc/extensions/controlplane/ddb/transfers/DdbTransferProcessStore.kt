// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.transfers

import com.fasterxml.jackson.databind.ObjectMapper
import org.eclipse.edc.connector.controlplane.transfer.spi.store.TransferProcessStore
import org.eclipse.edc.spi.query.Criterion
import org.eclipse.edc.spi.query.CriterionOperatorRegistry
import org.eclipse.edc.spi.query.QuerySpec
import org.eclipse.edc.spi.result.StoreResult
import org.eclipse.edc.store.ReflectionBasedQueryResolver
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.edc.extensions.common.ddb.EntityType
import software.amazon.edc.extensions.common.ddb.leases.AbstractLeasableEntityDao
import software.amazon.edc.extensions.common.ddb.types.Leasable
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.common.ddb.utility.extractStateValues
import software.amazon.edc.extensions.common.ddb.utility.gsiStatePk
import software.amazon.edc.extensions.common.ddb.utility.keyFromPkSk
import software.amazon.edc.extensions.common.ddb.utility.queryRequestFromId
import software.amazon.edc.extensions.common.ddb.utility.queryRequestFromPk
import software.amazon.edc.extensions.common.ddb.utility.toPredicate
import software.amazon.edc.extensions.controlplane.ddb.types.TransferProcess
import software.amazon.edc.extensions.controlplane.ddb.types.toDdbTransferProcess
import java.time.Clock
import java.util.stream.Stream
import kotlin.streams.asStream
import org.eclipse.edc.connector.controlplane.transfer.spi.types.TransferProcess as EdcTransferProcess

class DdbTransferProcessStore(
    clock: Clock,
    leaseHolder: String,
    leaseTable: DynamoDbTable<Lease>,
    private val criterionOperatorRegistry: CriterionOperatorRegistry,
    private val objectMapper: ObjectMapper,
    private val table: DynamoDbTable<TransferProcess>,
) : AbstractLeasableEntityDao(
        clock = clock,
        leaseHolder = leaseHolder,
        leaseTable = leaseTable,
    ),
    TransferProcessStore {
    private val correlationIdIndex = table.index(TransferProcess.GSI_CORRELATION_ID)
    private val stateIndex = table.index(TransferProcess.GSI_STATE)
    private val queryResolver = ReflectionBasedQueryResolver(EdcTransferProcess::class.java, criterionOperatorRegistry)

    override fun findById(id: String): EdcTransferProcess? = getTransferProcess(id)?.toEdcTransferProcess(objectMapper)

    override fun nextNotLeased(
        max: Int,
        vararg criteria: Criterion,
    ): MutableList<EdcTransferProcess> {
        val predicate = criteria.toList().toPredicate<Any>(criterionOperatorRegistry)
        val stateValues = criteria.extractStateValues()
        val items =
            if (stateValues != null) {
                stateValues
                    .flatMap {
                        stateIndex.query(queryRequestFromId(gsiStatePk(EntityType.TRANSFER_PROCESS, it))).flatMap { page ->
                            page.items()
                        }
                    }.asSequence()
            } else {
                table.query(queryRequestFromPk(EntityType.TRANSFER_PROCESS)).flatMap { it.items() }.asSequence()
            }
        return items
            .filterNot { hasActiveLease(it) }
            .map { it.toEdcTransferProcess(objectMapper) }
            .filter { predicate.test(it) }
            .sortedBy { it.stateTimestamp }
            .take(max)
            .onEach { acquireLease(it.id) }
            .toMutableList()
    }

    override fun findByIdAndLease(id: String): StoreResult<EdcTransferProcess> {
        val transferProcess =
            getTransferProcess(id)
                ?: return StoreResult.notFound("TransferProcess with ID $id not found!")
        return try {
            acquireLease(transferProcess)
            StoreResult.success(transferProcess.toEdcTransferProcess(objectMapper))
        } catch (e: IllegalStateException) {
            StoreResult.alreadyLeased("TransferProcess $id is already leased!")
        }
    }

    override fun save(transferProcess: EdcTransferProcess) {
        val leaseId =
            if (getTransferProcess(transferProcess.id) == null) {
                null
            } else {
                acquireLease(transferProcess.id)
            }
        try {
            table.putItem(transferProcess.toDdbTransferProcess(objectMapper, leaseId))
        } finally {
            if (leaseId != null) {
                breakLease(transferProcess.id)
            }
        }
    }

    override fun findForCorrelationId(correlationId: String): EdcTransferProcess? =
        correlationIdIndex
            .query(queryRequestFromId(correlationId))
            .toList()
            .flatMap { it.items() }
            .firstOrNull()
            ?.toEdcTransferProcess(objectMapper)

    override fun delete(id: String) {
        if (hasLease(id)) {
            throw IllegalStateException("TransferProcess $id cannot be deleted because it is currently leased!")
        }
        table.deleteItem(keyFromPkSk(EntityType.TRANSFER_PROCESS, id))
    }

    override fun findAll(querySpec: QuerySpec): Stream<EdcTransferProcess> =
        queryResolver.query(
            table
                .query(queryRequestFromPk(EntityType.TRANSFER_PROCESS))
                .flatMap { it.items() }
                .asSequence()
                .sortedBy { it.id }
                .map { it.toEdcTransferProcess(objectMapper) }
                .asStream(),
            querySpec,
        )

    override fun getLeasableById(id: String): Leasable? = getTransferProcess(id)

    override fun updateLeaseId(leasable: Leasable) {
        table.updateItem(leasable as TransferProcess)
    }

    private fun getTransferProcess(id: String): TransferProcess? = table.getItem(keyFromPkSk(EntityType.TRANSFER_PROCESS, id))
}
