// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.ddb.types

import com.fasterxml.jackson.databind.ObjectMapper
import org.eclipse.edc.connector.dataplane.spi.provision.ProvisionResource
import org.eclipse.edc.spi.types.domain.DataAddress
import org.eclipse.edc.spi.types.domain.transfer.FlowType
import org.eclipse.edc.spi.types.domain.transfer.TransferType
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbConvertedBy
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSecondaryPartitionKey
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSecondarySortKey
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSortKey
import software.amazon.edc.extensions.common.ddb.EntityType
import software.amazon.edc.extensions.common.ddb.ListOfMapsConverter
import software.amazon.edc.extensions.common.ddb.MapStringAnyConverter
import software.amazon.edc.extensions.common.ddb.types.Leasable
import software.amazon.edc.extensions.common.ddb.utility.convertValueToMapStringAny
import software.amazon.edc.extensions.common.ddb.utility.gsiStatePk
import java.net.URI
import org.eclipse.edc.connector.dataplane.spi.DataFlow as EdcDataFlow

@DynamoDbBean
data class DataFlow(
    @get:DynamoDbPartitionKey
    @get:DynamoDbAttribute("pk")
    var pk: String = EntityType.DATA_FLOW,
    @get:DynamoDbSortKey
    @get:DynamoDbAttribute("sk")
    var sk: String = "",
    @get:DynamoDbAttribute(CALLBACK_ADDRESS)
    var callbackAddress: String? = null,
    @get:DynamoDbAttribute(CREATED_AT)
    var createdAt: Long = 0L,
    @get:DynamoDbAttribute(DESTINATION)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var destination: Map<String, Any>? = null,
    @get:DynamoDbAttribute(ERROR_DETAIL)
    var errorDetail: String? = null,
    @get:DynamoDbAttribute(GSI_STATE_PK)
    @get:DynamoDbSecondaryPartitionKey(indexNames = [GSI_STATE])
    var gsiStatePk: String? = null,
    @get:DynamoDbAttribute(TRANSFER_TYPE_DESTINATION)
    var transferTypeDestination: String? = null,
    @get:DynamoDbAttribute(TRANSFER_TYPE_FLOW)
    var transferTypeFlow: String? = null,
    @get:DynamoDbAttribute(TRANSFER_TYPE_RESPONSE_CHANNEL)
    var transferTypeResponseChannel: String? = null,
    @get:DynamoDbAttribute(LEASE_ID)
    override var leaseId: String? = null,
    @get:DynamoDbAttribute(PROPERTIES)
    var properties: Map<String, String>? = null,
    @get:DynamoDbAttribute(RESOURCE_DEFINITIONS)
    @get:DynamoDbConvertedBy(ListOfMapsConverter::class)
    var resourceDefinitions: List<Map<String, Any>>? = null,
    @get:DynamoDbAttribute(RUNTIME_ID)
    var runtimeId: String? = null,
    @get:DynamoDbAttribute(SOURCE)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var source: Map<String, Any>? = null,
    @get:DynamoDbAttribute(STATE)
    var state: Int? = null,
    @get:DynamoDbAttribute(STATE_COUNT)
    var stateCount: Int = 0,
    @get:DynamoDbAttribute(STATE_TIMESTAMP)
    @get:DynamoDbSecondarySortKey(indexNames = [GSI_STATE])
    var stateTimestamp: Long = 0,
    @get:DynamoDbAttribute(TRACE_CONTEXT)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var traceContext: Map<String, String>? = null,
    @get:DynamoDbAttribute(UPDATED_AT)
    var updatedAt: Long = 0L,
) : Leasable {
    val id: String get() = sk

    fun toEdcDataFlow(objectMapper: ObjectMapper): EdcDataFlow =
        EdcDataFlow.Builder
            .newInstance()
            .apply {
                id(sk)
                callbackAddress(callbackAddress?.let { URI.create(it) })
                createdAt(createdAt)
                destination(
                    destination?.let {
                        DataAddress.Builder
                            .newInstance()
                            .properties(it)
                            .build()
                    },
                )
                errorDetail(errorDetail)
                transferType(
                    transferTypeFlow?.let {
                        TransferType(transferTypeDestination ?: "", FlowType.valueOf(it), transferTypeResponseChannel)
                    },
                )
                properties(properties)
                runtimeId(runtimeId)
                source(
                    source?.let {
                        DataAddress.Builder
                            .newInstance()
                            .properties(it)
                            .build()
                    },
                )
                state?.let { state(it) }
                stateCount(stateCount)
                stateTimestamp(stateTimestamp)
                traceContext(traceContext)
                updatedAt(updatedAt)
            }.build().also { flow ->
                resourceDefinitions?.takeIf { it.isNotEmpty() }?.let { defs ->
                    flow.addResourceDefinitions(defs.map { objectMapper.convertValue(it, ProvisionResource::class.java) })
                }
            }

    companion object {
        const val CALLBACK_ADDRESS = "callbackAddress"
        const val CREATED_AT = "createdAt"
        const val DESTINATION = "destination"
        const val ERROR_DETAIL = "errorDetail"
        const val GSI_STATE_PK = "gsiStatePk"
        const val TRANSFER_TYPE_DESTINATION = "transferTypeDestination"
        const val TRANSFER_TYPE_FLOW = "transferTypeFlow"
        const val TRANSFER_TYPE_RESPONSE_CHANNEL = "transferTypeResponseChannel"
        const val LEASE_ID = "leaseId"
        const val PROPERTIES = "properties"
        const val RESOURCE_DEFINITIONS = "resourceDefinitions"
        const val RUNTIME_ID = "runtimeId"
        const val SOURCE = "source"
        const val STATE = "state"
        const val STATE_COUNT = "stateCount"
        const val STATE_TIMESTAMP = "stateTimestamp"
        const val TRACE_CONTEXT = "traceContext"
        const val UPDATED_AT = "updatedAt"

        const val GSI_STATE = "gsi-state"
    }
}

fun EdcDataFlow.toDdbDataFlow(
    objectMapper: ObjectMapper,
    leaseId: String? = null,
): DataFlow =
    DataFlow(
        pk = EntityType.DATA_FLOW,
        sk = id,
        callbackAddress = callbackAddress.toString(),
        createdAt = createdAt,
        destination = destination?.properties,
        errorDetail = errorDetail,
        gsiStatePk = state?.let { gsiStatePk(EntityType.DATA_FLOW, it) },
        transferTypeDestination = transferType?.destinationType(),
        transferTypeFlow = transferType?.flowType()?.toString(),
        transferTypeResponseChannel = transferType?.responseChannelType(),
        leaseId = leaseId,
        properties = properties,
        resourceDefinitions = resourceDefinitions?.map { objectMapper.convertValueToMapStringAny(it) },
        runtimeId = runtimeId,
        source = source?.properties,
        state = state,
        stateCount = stateCount,
        stateTimestamp = stateTimestamp,
        traceContext = traceContext,
        updatedAt = updatedAt,
    )
