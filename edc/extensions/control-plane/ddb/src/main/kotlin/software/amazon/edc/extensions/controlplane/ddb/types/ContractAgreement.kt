// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.types

import com.fasterxml.jackson.databind.ObjectMapper
import org.eclipse.edc.policy.model.Policy
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbConvertedBy
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSortKey
import software.amazon.edc.extensions.common.ddb.EntityType
import software.amazon.edc.extensions.common.ddb.MapStringAnyConverter
import software.amazon.edc.extensions.common.ddb.utility.convertValueToMapStringAny
import org.eclipse.edc.connector.controlplane.contract.spi.types.agreement.ContractAgreement as EdcContractAgreement

@DynamoDbBean
data class ContractAgreement(
    @get:DynamoDbPartitionKey
    @get:DynamoDbAttribute("pk")
    var pk: String = EntityType.CONTRACT_AGREEMENT,
    @get:DynamoDbSortKey
    @get:DynamoDbAttribute("sk")
    var sk: String = "",
    @get:DynamoDbAttribute(SIGNING_DATE)
    var signingDate: Long = 0,
    @get:DynamoDbAttribute(ASSET_ID)
    var assetId: String = "",
    @get:DynamoDbAttribute(CONSUMER_AGENT_ID)
    var consumerAgentId: String? = null,
    @get:DynamoDbAttribute(END_DATE)
    var endDate: Long? = null,
    @get:DynamoDbAttribute(POLICY)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var policy: Map<String, Any>? = null,
    @get:DynamoDbAttribute(PROVIDER_AGENT_ID)
    var providerAgentId: String? = null,
    @get:DynamoDbAttribute(START_DATE)
    var startDate: Long? = null,
) {
    val id: String get() = sk

    fun toEdcContractAgreement(objectMapper: ObjectMapper): EdcContractAgreement =
        EdcContractAgreement.Builder
            .newInstance()
            .apply {
                id(sk)
                contractSigningDate(signingDate)
                assetId(assetId)
                consumerId(consumerAgentId)
                policy(objectMapper.convertValue(policy, Policy::class.java))
                providerId(providerAgentId)
            }.build()

    companion object {
        const val ASSET_ID = "assetId"
        const val CONSUMER_AGENT_ID = "consumerAgentId"
        const val END_DATE = "endDate"
        const val POLICY = "policy"
        const val PROVIDER_AGENT_ID = "providerAgentId"
        const val SIGNING_DATE = "signingDate"
        const val START_DATE = "startDate"
    }
}

fun EdcContractAgreement.toDdbContractAgreement(objectMapper: ObjectMapper): ContractAgreement =
    ContractAgreement(
        pk = EntityType.CONTRACT_AGREEMENT,
        sk = id,
        signingDate = contractSigningDate,
        assetId = assetId,
        consumerAgentId = consumerId,
        policy = objectMapper.convertValueToMapStringAny(policy),
        providerAgentId = providerId,
    )
