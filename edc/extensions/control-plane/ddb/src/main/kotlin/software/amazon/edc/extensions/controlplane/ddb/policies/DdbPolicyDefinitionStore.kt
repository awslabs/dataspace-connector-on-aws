// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.policies

import com.fasterxml.jackson.databind.ObjectMapper
import org.eclipse.edc.connector.controlplane.policy.spi.store.PolicyDefinitionStore
import org.eclipse.edc.connector.controlplane.policy.spi.store.PolicyDefinitionStore.POLICY_ALREADY_EXISTS
import org.eclipse.edc.connector.controlplane.policy.spi.store.PolicyDefinitionStore.POLICY_NOT_FOUND
import org.eclipse.edc.spi.query.CriterionOperatorRegistry
import org.eclipse.edc.spi.query.QuerySpec
import org.eclipse.edc.spi.result.StoreResult
import org.eclipse.edc.store.ReflectionBasedQueryResolver
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.edc.extensions.common.ddb.utility.keyFromId
import software.amazon.edc.extensions.common.ddb.utility.registerConstraintSubtypes
import software.amazon.edc.extensions.controlplane.ddb.types.PolicyDefinition
import software.amazon.edc.extensions.controlplane.ddb.types.toDdbPolicyDefinition
import java.util.stream.Stream
import kotlin.streams.asStream
import org.eclipse.edc.connector.controlplane.policy.spi.PolicyDefinition as EdcPolicyDefinition

class DdbPolicyDefinitionStore(
    criterionOperatorRegistry: CriterionOperatorRegistry,
    private val objectMapper: ObjectMapper,
    private val table: DynamoDbTable<PolicyDefinition>,
) : PolicyDefinitionStore {
    private val queryResolver = ReflectionBasedQueryResolver(EdcPolicyDefinition::class.java, criterionOperatorRegistry)

    override fun findById(id: String): EdcPolicyDefinition? = getPolicyDefinition(id)?.toEdcPolicyDefinition(objectMapper)

    override fun findAll(querySpec: QuerySpec): Stream<EdcPolicyDefinition> =
        queryResolver.query(
            table.scan().items().asSequence().map { it.toEdcPolicyDefinition(objectMapper) }.asStream(),
            querySpec,
        )

    override fun create(policyDefinition: EdcPolicyDefinition): StoreResult<EdcPolicyDefinition> =
        if (getPolicyDefinition(policyDefinition.id) == null) {
            table.putItem(policyDefinition.toDdbPolicyDefinition(objectMapper))
            StoreResult.success(policyDefinition)
        } else {
            StoreResult.alreadyExists(String.format(POLICY_ALREADY_EXISTS, policyDefinition.id))
        }

    override fun update(policyDefinition: EdcPolicyDefinition): StoreResult<EdcPolicyDefinition> =
        if (getPolicyDefinition(policyDefinition.id) == null) {
            StoreResult.notFound(String.format(POLICY_NOT_FOUND, policyDefinition.id))
        } else {
            table.updateItem(policyDefinition.toDdbPolicyDefinition(objectMapper))
            StoreResult.success(policyDefinition)
        }

    override fun delete(id: String): StoreResult<EdcPolicyDefinition> {
        val policyDefinition =
            getPolicyDefinition(id)
                ?: return StoreResult.notFound(String.format(POLICY_NOT_FOUND, id))
        return StoreResult.success(table.deleteItem(policyDefinition).toEdcPolicyDefinition(objectMapper))
    }

    private fun getPolicyDefinition(id: String): PolicyDefinition? = table.getItem(keyFromId(id))

    init {
        objectMapper.registerConstraintSubtypes()
    }
}
