// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.types

import com.fasterxml.jackson.databind.ObjectMapper
import org.eclipse.edc.connector.controlplane.transfer.spi.types.DeprovisionedResource
import org.eclipse.edc.connector.controlplane.transfer.spi.types.ProvisionedResourceSet
import org.eclipse.edc.connector.controlplane.transfer.spi.types.ResourceManifest
import org.eclipse.edc.spi.entity.ProtocolMessages
import org.eclipse.edc.spi.types.domain.DataAddress
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
import org.eclipse.edc.connector.controlplane.transfer.spi.types.TransferProcess as EdcTransferProcess

@DynamoDbBean
data class TransferProcess(
    @get:DynamoDbAttribute(ID)
    @get:DynamoDbPartitionKey
    var id: String = "",
    @get:DynamoDbAttribute(ASSET_ID)
    var assetId: String? = null,
    @get:DynamoDbAttribute(CALLBACK_ADDRESSES)
    @get:DynamoDbConvertedBy(ListOfMapsConverter::class)
    var callbackAddresses: List<Map<String, Any>>? = null,
    @get:DynamoDbAttribute(CONTENT_DATA_ADDRESS)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var contentDataAddress: Map<String, Any>? = null,
    @get:DynamoDbAttribute(CONTRACT_ID)
    var contractId: String? = null,
    @get:DynamoDbAttribute(CORRELATION_ID)
    @get:DynamoDbSecondaryPartitionKey(indexNames = [INDEX_CORRELATION_ID])
    var correlationId: String? = null,
    @get:DynamoDbAttribute(COUNTER_PARTY_ADDRESS)
    var counterPartyAddress: String? = null,
    @get:DynamoDbAttribute(CREATED_AT)
    var createdAt: Long = 0,
    @get:DynamoDbAttribute(DATA_DESTINATION)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var dataDestination: Map<String, Any>? = null,
    @get:DynamoDbAttribute(DATA_PLANE_ID)
    var dataPlaneId: String? = null,
    @get:DynamoDbAttribute(DEPROVISIONED_RESOURCES)
    @get:DynamoDbConvertedBy(ListOfMapsConverter::class)
    var deprovisionedResources: List<Map<String, Any>>? = null,
    @get:DynamoDbAttribute(ERROR_DETAIL)
    var errorDetail: String? = null,
    @get:DynamoDbAttribute(LEASE_ID)
    override var leaseId: String? = null,
    @get:DynamoDbAttribute(PENDING)
    var pending: Boolean = false,
    @get:DynamoDbAttribute(PRIVATE_PROPERTIES)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var privateProperties: Map<String, Any>? = null,
    @get:DynamoDbAttribute(PROTOCOL)
    var protocol: String? = null,
    @get:DynamoDbAttribute(PROTOCOL_MESSAGES)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var protocolMessages: Map<String, Any>? = null,
    @get:DynamoDbAttribute(PROVISIONED_RESOURCE_SET)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var provisionedResourceSet: Map<String, Any>? = null,
    @get:DynamoDbAttribute(RESOURCE_MANIFEST)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var resourceManifest: Map<String, Any>? = null,
    @get:DynamoDbAttribute(STATE)
    var state: Int = 0,
    @get:DynamoDbAttribute(STATE_COUNT)
    var stateCount: Int = 0,
    @get:DynamoDbAttribute(STATE_TIMESTAMP)
    var stateTimestamp: Long = 0,
    @get:DynamoDbAttribute(TRACE_CONTEXT)
    var traceContext: Map<String, String>? = null,
    @get:DynamoDbAttribute(TRANSFER_TYPE)
    var transferType: String? = null,
    @get:DynamoDbAttribute(TYPE)
    var type: String = "",
    @get:DynamoDbAttribute(UPDATED_AT)
    var updatedAt: Long = 0,
) : Leasable {
    fun toEdcTransferProcess(objectMapper: ObjectMapper): EdcTransferProcess =
        EdcTransferProcess.Builder
            .newInstance()
            .apply {
                id(id)
                assetId(assetId)
                callbackAddresses(callbackAddresses?.map { objectMapper.convertValue(it, CallbackAddress::class.java) })
                contentDataAddress?.let {
                    contentDataAddress(
                        DataAddress.Builder
                            .newInstance()
                            .properties(contentDataAddress)
                            .build(),
                    )
                }
                contractId(contractId)
                correlationId(correlationId)
                counterPartyAddress(counterPartyAddress)
                createdAt(createdAt)
                dataDestination?.let {
                    dataDestination(
                        DataAddress.Builder
                            .newInstance()
                            .properties(dataDestination)
                            .build(),
                    )
                }
                dataPlaneId(dataPlaneId)
                deprovisionedResources(
                    deprovisionedResources?.map { objectMapper.convertValue(it, DeprovisionedResource::class.java) },
                )
                errorDetail(errorDetail)
                pending(pending)
                privateProperties(privateProperties)
                protocol(protocol)
                protocolMessages(objectMapper.convertValue(protocolMessages, ProtocolMessages::class.java))
                provisionedResourceSet(objectMapper.convertValue(provisionedResourceSet, ProvisionedResourceSet::class.java))
                resourceManifest(objectMapper.convertValue(resourceManifest, ResourceManifest::class.java))
                state(state)
                stateCount(stateCount)
                stateTimestamp(stateTimestamp)
                traceContext(traceContext)
                transferType(transferType)
                type(EdcTransferProcess.Type.valueOf(type))
                updatedAt(updatedAt)
            }.build()

    companion object {
        const val ASSET_ID = "assetId"
        const val CALLBACK_ADDRESSES = "callbackAddresses"
        const val CONTENT_DATA_ADDRESS = "contentDataAddress"
        const val CONTRACT_ID = "contractId"
        const val CORRELATION_ID = "correlationId"
        const val COUNTER_PARTY_ADDRESS = "counterPartyAddress"
        const val CREATED_AT = "createdAt"
        const val DATA_DESTINATION = "dataDestination"
        const val DATA_PLANE_ID = "dataPlaneId"
        const val DEPROVISIONED_RESOURCES = "deprovisionedResources"
        const val ERROR_DETAIL = "errorDetail"
        const val ID = "id"
        const val LEASE_ID = "leaseId"
        const val PENDING = "pending"
        const val PRIVATE_PROPERTIES = "privateProperties"
        const val PROTOCOL = "protocol"
        const val PROTOCOL_MESSAGES = "protocolMessages"
        const val PROVISIONED_RESOURCE_SET = "provisionedResourceSet"
        const val RESOURCE_MANIFEST = "resourceManifest"
        const val STATE = "state"
        const val STATE_COUNT = "stateCount"
        const val STATE_TIMESTAMP = "stateTimestamp"
        const val TRACE_CONTEXT = "traceContext"
        const val TRANSFER_TYPE = "transferType"
        const val TYPE = "type"
        const val UPDATED_AT = "updatedAt"

        const val INDEX_CORRELATION_ID = "index-correlationId"
        const val TABLE_NAME = "TransferProcesses"
    }
}

fun EdcTransferProcess.toDdbTransferProcess(
    objectMapper: ObjectMapper,
    leaseId: String? = null,
): TransferProcess =
    TransferProcess(
        id = id,
        assetId = assetId,
        callbackAddresses = callbackAddresses.map { objectMapper.convertValueToMapStringAny(it) },
        contentDataAddress = contentDataAddress?.properties,
        contractId = contractId,
        correlationId = correlationId,
        counterPartyAddress = counterPartyAddress,
        createdAt = createdAt,
        dataDestination = dataDestination?.properties,
        dataPlaneId = dataPlaneId,
        deprovisionedResources = deprovisionedResources.map { objectMapper.convertValueToMapStringAny(it) },
        errorDetail = errorDetail,
        leaseId = leaseId,
        pending = isPending,
        privateProperties = privateProperties,
        protocol = protocol,
        protocolMessages = protocolMessages?.let { objectMapper.convertValueToMapStringAny(protocolMessages) },
        provisionedResourceSet =
            provisionedResourceSet?.let {
                objectMapper.convertValueToMapStringAny(provisionedResourceSet)
            },
        resourceManifest = resourceManifest?.let { objectMapper.convertValueToMapStringAny(resourceManifest) },
        state = state,
        stateCount = stateCount,
        stateTimestamp = stateTimestamp,
        traceContext = traceContext,
        transferType = transferType,
        type = type.toString(),
        updatedAt = updatedAt,
    )
