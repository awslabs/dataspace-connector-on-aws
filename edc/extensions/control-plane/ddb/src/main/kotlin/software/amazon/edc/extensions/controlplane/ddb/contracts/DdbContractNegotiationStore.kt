// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.contracts

import com.fasterxml.jackson.databind.ObjectMapper
import org.eclipse.edc.connector.controlplane.contract.spi.negotiation.store.ContractNegotiationStore
import org.eclipse.edc.spi.query.Criterion
import org.eclipse.edc.spi.query.CriterionOperatorRegistry
import org.eclipse.edc.spi.query.QuerySpec
import org.eclipse.edc.spi.query.SortOrder
import org.eclipse.edc.spi.result.StoreResult
import org.eclipse.edc.store.ReflectionBasedQueryResolver
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.edc.extensions.common.ddb.EntityType
import software.amazon.edc.extensions.common.ddb.STATE_INDEX_CACHE_TTL_MILLIS
import software.amazon.edc.extensions.common.ddb.leases.AbstractLeasableEntityDao
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.common.ddb.utility.IterationCache
import software.amazon.edc.extensions.common.ddb.utility.applyOffsetAndLimit
import software.amazon.edc.extensions.common.ddb.utility.extractStateValues
import software.amazon.edc.extensions.common.ddb.utility.extractStringValue
import software.amazon.edc.extensions.common.ddb.utility.getGenericPropertyComparator
import software.amazon.edc.extensions.common.ddb.utility.hasProperty
import software.amazon.edc.extensions.common.ddb.utility.keyFromPkSk
import software.amazon.edc.extensions.common.ddb.utility.queryRequestFromId
import software.amazon.edc.extensions.common.ddb.utility.queryRequestFromPk
import software.amazon.edc.extensions.common.ddb.utility.registerConstraintSubtypes
import software.amazon.edc.extensions.common.ddb.utility.toPredicate
import software.amazon.edc.extensions.controlplane.ddb.types.ContractAgreement
import software.amazon.edc.extensions.controlplane.ddb.types.ContractNegotiation
import software.amazon.edc.extensions.controlplane.ddb.types.toDdbContractAgreement
import software.amazon.edc.extensions.controlplane.ddb.types.toDdbContractNegotiation
import java.time.Clock
import java.util.stream.Stream
import kotlin.streams.asStream
import org.eclipse.edc.connector.controlplane.contract.spi.types.agreement.ContractAgreement as EdcContractAgreement
import org.eclipse.edc.connector.controlplane.contract.spi.types.negotiation.ContractNegotiation as EdcContractNegotiation

class DdbContractNegotiationStore(
    clock: Clock,
    private val criterionOperatorRegistry: CriterionOperatorRegistry,
    leaseHolder: String,
    leaseTable: DynamoDbTable<Lease>,
    private val contractAgreementTable: DynamoDbTable<ContractAgreement>,
    private val contractNegotiationTable: DynamoDbTable<ContractNegotiation>,
    private val objectMapper: ObjectMapper,
) : AbstractLeasableEntityDao(
        clock = clock,
        leaseHolder = leaseHolder,
        leaseTable = leaseTable,
    ),
    ContractNegotiationStore {
    private val negotiationQueryResolver =
        ReflectionBasedQueryResolver(EdcContractNegotiation::class.java, criterionOperatorRegistry)
    private val stateIndex = contractNegotiationTable.index(ContractNegotiation.GSI_STATE)
    private val stateCache = IterationCache<ContractNegotiation>(STATE_INDEX_CACHE_TTL_MILLIS)

    override fun findById(id: String): EdcContractNegotiation? {
        val contractNegotiation = getContractNegotiation(id) ?: return null
        val contractAgreement = contractNegotiation.agreementId?.let { getContractAgreement(it) }
        return contractNegotiation.toEdcContractNegotiation(objectMapper, contractAgreement)
    }

    override fun nextNotLeased(
        max: Int,
        vararg criteria: Criterion,
    ): MutableList<EdcContractNegotiation> {
        val querySpec =
            QuerySpec.Builder
                .newInstance()
                .filter(criteria.toList())
                .sortField("stateTimestamp")
                .sortOrder(SortOrder.ASC)
                .limit(max)
                .build()
        val stateValues = criteria.extractStateValues()
        val typeFilter = criteria.extractStringValue("type")
        val indexed =
            stateCache.getOrLoad {
                stateIndex.query(queryRequestFromId(EntityType.CONTRACT_NEGOTIATION)).flatMap { it.items() }
            }
        val items: Sequence<ContractNegotiation> =
            if (stateValues != null) {
                indexed
                    .asSequence()
                    .filter { it.state in stateValues }
                    .let { seq -> if (typeFilter != null) seq.filter { it.type == typeFilter } else seq }
            } else {
                indexed.asSequence()
            }
        val leased = activeLeaseIds()
        return items
            .filterNot { it.sk in leased }
            .sortedBy { it.id }
            .sortedWith(querySpec.getGenericPropertyComparator())
            .map {
                acquireLease(it.sk)
                val agreement = it.agreementId?.let { agreementId -> getContractAgreement(agreementId) }
                it.toEdcContractNegotiation(objectMapper, agreement)
            }.applyOffsetAndLimit(querySpec)
            .toMutableList()
    }

    override fun findByIdAndLease(id: String): StoreResult<EdcContractNegotiation> {
        val contractNegotiation =
            getContractNegotiation(id)
                ?: return StoreResult.notFound("ContractNegotiation with ID $id not found!")
        return try {
            acquireLease(contractNegotiation.sk)
            val agreement = contractNegotiation.agreementId?.let { getContractAgreement(it) }
            StoreResult.success(contractNegotiation.toEdcContractNegotiation(objectMapper, agreement))
        } catch (e: IllegalStateException) {
            StoreResult.alreadyLeased("ContractNegotiation with ID $id is already leased!")
        }
    }

    override fun save(contractNegotiation: EdcContractNegotiation): StoreResult<Void> {
        if (isLeasedByAnother(contractNegotiation.id)) {
            return StoreResult.alreadyLeased("ContractNegotiation ${contractNegotiation.id} is already leased!")
        }
        contractNegotiationTable.putItem(contractNegotiation.toDdbContractNegotiation(objectMapper))
        if (contractNegotiation.contractAgreement != null) {
            contractAgreementTable.putItem(contractNegotiation.contractAgreement.toDdbContractAgreement(objectMapper))
        }
        breakLease(contractNegotiation.id)
        stateCache.invalidate()
        return StoreResult.success()
    }

    override fun findContractAgreement(contractId: String): EdcContractAgreement? =
        getContractAgreement(contractId)?.toEdcContractAgreement(objectMapper)

    override fun deleteById(negotiationId: String): StoreResult<Void> {
        val contractNegotiation =
            getContractNegotiation(negotiationId)
                ?: return StoreResult.notFound("ContractNegotiation with ID $negotiationId not found!")
        val contractAgreementId = contractNegotiation.agreementId
        if (contractAgreementId != null && getContractAgreement(contractAgreementId) != null) {
            return StoreResult.generalError(
                "Cannot delete ContractNegotiation $negotiationId: ContractAgreement already created.",
            )
        }
        if (hasLease(negotiationId)) {
            return StoreResult.alreadyLeased(
                "ContractNegotiation with ID $negotiationId cannot be deleted because it is currently leased!",
            )
        }
        contractNegotiationTable.deleteItem(keyFromPkSk(EntityType.CONTRACT_NEGOTIATION, negotiationId))
        stateCache.invalidate()
        return StoreResult.success()
    }

    override fun queryNegotiations(querySpec: QuerySpec): Stream<EdcContractNegotiation> {
        val all =
            contractNegotiationTable
                .query(queryRequestFromPk(EntityType.CONTRACT_NEGOTIATION))
                .flatMap { it.items() }
                .asSequence()
                .map {
                    it.toEdcContractNegotiation(
                        objectMapper,
                        it.agreementId?.let { agreementId -> getContractAgreement(agreementId) },
                    )
                }.asStream()
        return negotiationQueryResolver.query(all, querySpec)
    }

    override fun queryAgreements(querySpec: QuerySpec): Stream<EdcContractAgreement> {
        if (querySpec.sortField != null && !EdcContractAgreement::class.hasProperty(querySpec.sortField)) {
            throw IllegalArgumentException("Sort field ${querySpec.sortField} is not valid for contract agreements!")
        }
        val predicate = querySpec.filterExpression.toPredicate<Any>(criterionOperatorRegistry)
        return contractAgreementTable
            .query(queryRequestFromPk(EntityType.CONTRACT_AGREEMENT))
            .flatMap { it.items() }
            .asSequence()
            .map { it.toEdcContractAgreement(objectMapper) }
            .filter { predicate.test(it) }
            .sortedWith(querySpec.getGenericPropertyComparator())
            .applyOffsetAndLimit(querySpec)
            .asStream()
    }

    private fun getContractAgreement(id: String): ContractAgreement? =
        contractAgreementTable.getItem(keyFromPkSk(EntityType.CONTRACT_AGREEMENT, id))

    private fun getContractNegotiation(id: String): ContractNegotiation? =
        contractNegotiationTable.getItem(keyFromPkSk(EntityType.CONTRACT_NEGOTIATION, id))

    init {
        objectMapper.registerConstraintSubtypes()
    }
}
