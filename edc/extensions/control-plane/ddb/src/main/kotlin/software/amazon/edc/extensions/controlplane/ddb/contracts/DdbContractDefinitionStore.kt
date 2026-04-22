// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.contracts

import com.fasterxml.jackson.databind.ObjectMapper
import org.eclipse.edc.connector.controlplane.contract.spi.offer.store.ContractDefinitionStore
import org.eclipse.edc.connector.controlplane.contract.spi.offer.store.ContractDefinitionStore.CONTRACT_DEFINITION_EXISTS
import org.eclipse.edc.connector.controlplane.contract.spi.offer.store.ContractDefinitionStore.CONTRACT_DEFINITION_NOT_FOUND
import org.eclipse.edc.spi.query.CriterionOperatorRegistry
import org.eclipse.edc.spi.query.QueryResolver
import org.eclipse.edc.spi.query.QuerySpec
import org.eclipse.edc.spi.result.StoreResult
import org.eclipse.edc.store.ReflectionBasedQueryResolver
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.edc.extensions.common.ddb.utility.keyFromId
import software.amazon.edc.extensions.controlplane.ddb.types.ContractDefinition
import software.amazon.edc.extensions.controlplane.ddb.types.toDdbContractDefinition
import java.util.stream.Stream
import org.eclipse.edc.connector.controlplane.contract.spi.types.offer.ContractDefinition as EdcContractDefinition

class DdbContractDefinitionStore(
    criterionOperatorRegistry: CriterionOperatorRegistry,
    private val objectMapper: ObjectMapper,
    private val table: DynamoDbTable<ContractDefinition>,
) : ContractDefinitionStore {
    private val queryResolver: QueryResolver<EdcContractDefinition> =
        ReflectionBasedQueryResolver(EdcContractDefinition::class.java, criterionOperatorRegistry)

    override fun findAll(querySpec: QuerySpec): Stream<EdcContractDefinition> {
//        log().info("findAll: $querySpec")
        return queryResolver.query(
            table
                .scan()
                .items()
                .stream()
                .map { it.toEdcContractDefinition(objectMapper) },
            querySpec,
        )
    }

    override fun findById(id: String): EdcContractDefinition? = getContractDefinition(id)?.toEdcContractDefinition(objectMapper)

    override fun save(contractDefinition: EdcContractDefinition): StoreResult<Void> =
        if (getContractDefinition(contractDefinition.id) == null) {
            table.putItem(contractDefinition.toDdbContractDefinition(objectMapper))
            StoreResult.success()
        } else {
            StoreResult.alreadyExists(String.format(CONTRACT_DEFINITION_EXISTS, contractDefinition.id))
        }

    override fun update(contractDefinition: EdcContractDefinition): StoreResult<Void> =
        if (getContractDefinition(contractDefinition.id) == null) {
            StoreResult.notFound(String.format(CONTRACT_DEFINITION_NOT_FOUND, contractDefinition.id))
        } else {
            table.updateItem(contractDefinition.toDdbContractDefinition(objectMapper))
            StoreResult.success()
        }

    override fun deleteById(id: String): StoreResult<EdcContractDefinition> {
        val notFound = StoreResult.notFound<EdcContractDefinition>(String.format(CONTRACT_DEFINITION_NOT_FOUND, id))
        val contractDefinition = getContractDefinition(id) ?: return notFound
        val deleted = table.deleteItem(contractDefinition)?.toEdcContractDefinition(objectMapper)
        return if (deleted == null) notFound else StoreResult.success(deleted)
    }

    private fun getContractDefinition(id: String): ContractDefinition? = table.getItem(keyFromId(id))
}
