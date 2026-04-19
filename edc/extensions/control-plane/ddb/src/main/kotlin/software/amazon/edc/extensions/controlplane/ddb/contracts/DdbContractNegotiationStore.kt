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
import software.amazon.edc.extensions.common.ddb.leases.AbstractLeasableEntityDao
import software.amazon.edc.extensions.common.ddb.types.Leasable
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.common.ddb.utility.applyOffsetAndLimit
import software.amazon.edc.extensions.common.ddb.utility.getGenericPropertyComparator
import software.amazon.edc.extensions.common.ddb.utility.hasProperty
import software.amazon.edc.extensions.common.ddb.utility.keyFromId
import software.amazon.edc.extensions.common.ddb.utility.registerConstraintSubtypes
import software.amazon.edc.extensions.common.ddb.utility.toScanRequest
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
    criterionOperatorRegistry: CriterionOperatorRegistry,
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

    override fun findById(id: String): EdcContractNegotiation? {
        val contractNegotiation = getContractNegotiation(id) ?: return null
        val contractAgreement = contractNegotiation.agreementId?.let { getContractAgreement(it) }
        return getContractNegotiation(id)?.toEdcContractNegotiation(objectMapper, contractAgreement)
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
        val request = querySpec.toScanRequest()
        return contractNegotiationTable
            .scan(request)
            .items()
            .asSequence()
            .filterNot { hasLease(it.id) }
            .sortedBy { it.id } // Required by EDC tests
            .sortedWith(querySpec.getGenericPropertyComparator())
            .map {
                acquireLease(it)
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
            acquireLease(contractNegotiation)
            val agreement = contractNegotiation.agreementId?.let { getContractAgreement(it) }
            StoreResult.success(contractNegotiation.toEdcContractNegotiation(objectMapper, agreement))
        } catch (e: IllegalStateException) {
//            log().error("ContractNegotiation $id is already leased!", e)
            StoreResult.alreadyLeased("ContractNegotiation with ID $id is already leased!")
        }
    }

    override fun save(contractNegotiation: EdcContractNegotiation) {
        val leaseId = getContractNegotiation(contractNegotiation.id)?.let { acquireLease(it) }
        try {
            val ddbContractNegotiation = contractNegotiation.toDdbContractNegotiation(objectMapper, leaseId)
//            log().info("Save: contractNegotiation=$ddbContractNegotiation")
            contractNegotiationTable.putItem(contractNegotiation.toDdbContractNegotiation(objectMapper, leaseId))
            if (contractNegotiation.contractAgreement != null) {
                val ddbContractAgreement = contractNegotiation.contractAgreement.toDdbContractAgreement(objectMapper)
//                log().info("Save: contractAgreement=$ddbContractAgreement")
                contractAgreementTable.putItem(ddbContractAgreement)
            }
        } finally {
            if (leaseId != null) {
                breakLease(contractNegotiation.id)
            }
        }
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
        contractNegotiationTable.deleteItem(keyFromId(negotiationId))
        return StoreResult.success()
    }

    override fun queryNegotiations(querySpec: QuerySpec): Stream<EdcContractNegotiation> {
        // This must support nested objects, so we'll need to fetch everything and feed it into the query resolver.
        val all =
            contractNegotiationTable
                .scan()
                .items()
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
        val scanRequest = querySpec.toScanRequest()
        return contractAgreementTable
            .scan(scanRequest)
            .items()
            .asSequence()
            .map { it.toEdcContractAgreement(objectMapper) }
            .sortedWith(querySpec.getGenericPropertyComparator())
            .applyOffsetAndLimit(querySpec)
            .asStream()
    }

    override fun getLeasableById(id: String): Leasable? = getContractNegotiation(id)

    override fun updateLeaseId(leasable: Leasable) {
        contractNegotiationTable.updateItem(leasable as ContractNegotiation)
    }

    private fun getContractAgreement(id: String): ContractAgreement? = contractAgreementTable.getItem(keyFromId(id))

    private fun getContractNegotiation(id: String): ContractNegotiation? = contractNegotiationTable.getItem(keyFromId(id))

    init {
        objectMapper.registerConstraintSubtypes()
    }
}
