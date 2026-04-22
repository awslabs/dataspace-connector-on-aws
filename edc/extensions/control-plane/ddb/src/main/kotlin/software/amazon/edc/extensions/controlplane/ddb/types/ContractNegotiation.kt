// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.types

import com.fasterxml.jackson.databind.ObjectMapper
import org.eclipse.edc.connector.controlplane.contract.spi.types.offer.ContractOffer
import org.eclipse.edc.spi.entity.ProtocolMessages
import org.eclipse.edc.spi.types.domain.callback.CallbackAddress
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbConvertedBy
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSecondaryPartitionKey
import software.amazon.edc.extensions.common.ddb.ListOfMapsConverter
import software.amazon.edc.extensions.common.ddb.MapStringAnyConverter
import software.amazon.edc.extensions.common.ddb.types.Leasable
import software.amazon.edc.extensions.common.ddb.utility.convertValueToMapStringAny
import org.eclipse.edc.connector.controlplane.contract.spi.types.negotiation.ContractNegotiation as EdcContractNegotiation

@DynamoDbBean
data class ContractNegotiation(
    @get:DynamoDbAttribute(ID)
    @get:DynamoDbPartitionKey
    var id: String = "",
    @get:DynamoDbAttribute(CREATED_AT)
    var createdAt: Long = 0L,
    @get:DynamoDbAttribute(AGREEMENT_ID)
    var agreementId: String? = null,
    @get:DynamoDbAttribute(CALLBACK_ADDRESSES)
    @get:DynamoDbConvertedBy(ListOfMapsConverter::class)
    var callbackAddresses: List<Map<String, Any>>? = null,
    @get:DynamoDbAttribute(CONTRACT_OFFERS)
    @get:DynamoDbConvertedBy(ListOfMapsConverter::class)
    var contractOffers: List<Map<String, Any>>? = null,
    @get:DynamoDbAttribute(CORRELATION_ID)
    @get:DynamoDbSecondaryPartitionKey(indexNames = [INDEX_CORRELATION_ID])
    var correlationId: String? = null,
    @get:DynamoDbAttribute(COUNTER_PARTY_ADDRESS)
    var counterPartyAddress: String = "",
    @get:DynamoDbAttribute(COUNTER_PARTY_ID)
    var counterPartyId: String = "",
    @get:DynamoDbAttribute(ERROR_DETAIL)
    var errorDetail: String? = null,
    @get:DynamoDbAttribute(LEASE_ID)
    override var leaseId: String? = null,
    @get:DynamoDbAttribute(PENDING)
    var pending: Boolean = false,
    @get:DynamoDbAttribute(PROTOCOL)
    var protocol: String = "",
    @get:DynamoDbAttribute(PROTOCOL_MESSAGES)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var protocolMessages: Map<String, Any>? = null,
    @get:DynamoDbAttribute(STATE)
    var state: Int = 0,
    @get:DynamoDbAttribute(STATE_COUNT)
    var stateCount: Int = 0,
    @get:DynamoDbAttribute(STATE_TIMESTAMP)
    var stateTimestamp: Long? = null,
    @get:DynamoDbAttribute(TRACE_CONTEXT)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var traceContext: Map<String, String>? = null,
    @get:DynamoDbAttribute(TYPE)
    var type: String = "",
    @get:DynamoDbAttribute(UPDATED_AT)
    var updatedAt: Long = 0L,
) : Leasable {
    fun toEdcContractNegotiation(
        objectMapper: ObjectMapper,
        contractAgreement: ContractAgreement? = null,
    ): EdcContractNegotiation =
        EdcContractNegotiation.Builder
            .newInstance()
            .apply {
                id(id)
                createdAt(createdAt)
                contractAgreement?.let { contractAgreement(it.toEdcContractAgreement(objectMapper)) }
                callbackAddresses(callbackAddresses?.map { objectMapper.convertValue(it, CallbackAddress::class.java) })
                contractOffers(contractOffers?.map { objectMapper.convertValue(it, ContractOffer::class.java) })
                correlationId(correlationId)
                counterPartyAddress(counterPartyAddress)
                counterPartyId(counterPartyId)
                errorDetail(errorDetail)
                pending(pending)
                protocol(protocol)
                protocolMessages(objectMapper.convertValue(protocolMessages, ProtocolMessages::class.java))
                state(state)
                stateCount(stateCount)
                stateTimestamp?.let { stateTimestamp(it) }
                traceContext?.let { traceContext(it) }
                type(EdcContractNegotiation.Type.valueOf(type))
                updatedAt(updatedAt)
            }.build()

    companion object {
        const val AGREEMENT_ID = "agreementId"
        const val CALLBACK_ADDRESSES = "callbackAddresses"
        const val CONTRACT_OFFERS = "contractOffers"
        const val CORRELATION_ID = "correlationId"
        const val COUNTER_PARTY_ADDRESS = "counterPartyAddress"
        const val COUNTER_PARTY_ID = "counterPartyId"
        const val CREATED_AT = "createdAt"
        const val ERROR_DETAIL = "errorDetail"
        const val ID = "id"
        const val LEASE_ID = "leaseId"
        const val PENDING = "pending"
        const val PROTOCOL = "protocol"
        const val PROTOCOL_MESSAGES = "protocolMessages"
        const val STATE = "state"
        const val STATE_COUNT = "stateCount"
        const val STATE_TIMESTAMP = "stateTimestamp"
        const val TRACE_CONTEXT = "traceContext"
        const val TYPE = "type"
        const val UPDATED_AT = "updatedAt"

        const val INDEX_CORRELATION_ID = "index-correlationId"
        const val TABLE_NAME = "ContractNegotiations"
    }
}

fun EdcContractNegotiation.toDdbContractNegotiation(
    objectMapper: ObjectMapper,
    leaseId: String? = null,
): ContractNegotiation =
    ContractNegotiation(
        id = id,
        createdAt = createdAt,
        agreementId = contractAgreement?.id,
        callbackAddresses = callbackAddresses?.map { objectMapper.convertValueToMapStringAny(it) },
        contractOffers = contractOffers?.map { objectMapper.convertValueToMapStringAny(it) },
        correlationId = correlationId,
        counterPartyAddress = counterPartyAddress,
        counterPartyId = counterPartyId,
        errorDetail = errorDetail,
        leaseId = leaseId,
        pending = isPending,
        protocol = protocol,
        protocolMessages = objectMapper.convertValueToMapStringAny(protocolMessages),
        state = state,
        stateCount = stateCount,
        stateTimestamp = stateTimestamp,
        traceContext = traceContext,
        type = type.toString(),
        updatedAt = updatedAt,
    )
