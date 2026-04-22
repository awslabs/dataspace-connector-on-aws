// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.types

import com.fasterxml.jackson.databind.ObjectMapper
import org.eclipse.edc.spi.query.Criterion
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbConvertedBy
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.edc.extensions.common.ddb.ListOfMapsConverter
import software.amazon.edc.extensions.common.ddb.MapStringAnyConverter
import software.amazon.edc.extensions.common.ddb.utility.convertValueToMapStringAny
import org.eclipse.edc.connector.controlplane.contract.spi.types.offer.ContractDefinition as EdcContractDefinition

@DynamoDbBean
data class ContractDefinition(
    @get:DynamoDbAttribute(ID)
    @get:DynamoDbPartitionKey
    var id: String = "",
    @get:DynamoDbAttribute(CREATED_AT)
    var createdAt: Long = 0L,
    @get:DynamoDbAttribute(ACCESS_POLICY_ID)
    var accessPolicyId: String = "",
    @get:DynamoDbAttribute(ASSETS_SELECTOR)
    @get:DynamoDbConvertedBy(ListOfMapsConverter::class)
    var assetsSelector: List<Map<String, Any>> = emptyList(),
    @get:DynamoDbAttribute(CONTRACT_POLICY_ID)
    var contractPolicyId: String = "",
    @get:DynamoDbAttribute(PRIVATE_PROPERTIES)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var privateProperties: Map<String, Any>? = null,
) {
    fun toEdcContractDefinition(objectMapper: ObjectMapper): EdcContractDefinition =
        EdcContractDefinition.Builder
            .newInstance()
            .apply {
                id(id)
                createdAt(createdAt)
                accessPolicyId(accessPolicyId)
                assetsSelector(assetsSelector.map { objectMapper.convertValue(it, Criterion::class.java) })
                contractPolicyId(contractPolicyId)
                privateProperties(privateProperties)
            }.build()

    companion object {
        const val ACCESS_POLICY_ID = "accessPolicyId"
        const val ASSETS_SELECTOR = "assetSelector"
        const val CONTRACT_POLICY_ID = "contractPolicyId"
        const val CREATED_AT = "createdAt"
        const val ID = "id"
        const val PRIVATE_PROPERTIES = "privateProperties"

        const val TABLE_NAME = "ContractDefinitions"
    }
}

fun EdcContractDefinition.toDdbContractDefinition(objectMapper: ObjectMapper): ContractDefinition =
    ContractDefinition(
        id = id,
        createdAt = createdAt,
        accessPolicyId = accessPolicyId,
        assetsSelector = assetsSelector.map { objectMapper.convertValueToMapStringAny(it) },
        contractPolicyId = contractPolicyId,
        privateProperties = privateProperties,
    )
