// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.ddb.types

import org.eclipse.edc.spi.types.domain.DataAddress
import org.eclipse.edc.spi.types.domain.transfer.FlowType
import org.eclipse.edc.spi.types.domain.transfer.TransferType
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbConvertedBy
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.edc.extensions.common.ddb.MapStringAnyConverter
import software.amazon.edc.extensions.common.ddb.types.Leasable
import java.net.URI
import org.eclipse.edc.connector.dataplane.spi.DataFlow as EdcDataFlow

@DynamoDbBean
data class DataFlow(
    @get:DynamoDbAttribute(ID)
    @get:DynamoDbPartitionKey
    var id: String = "",
    @get:DynamoDbAttribute(CALLBACK_ADDRESS)
    var callbackAddress: String? = null,
    @get:DynamoDbAttribute(CREATED_AT)
    var createdAt: Long = 0L,
    @get:DynamoDbAttribute(DESTINATION)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var destination: Map<String, Any>? = null,
    @get:DynamoDbAttribute(ERROR_DETAIL)
    var errorDetail: String? = null,
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
    @get:DynamoDbAttribute(SOURCE)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var source: Map<String, Any>? = null,
    @get:DynamoDbAttribute(STATE)
    var state: Int? = null,
    @get:DynamoDbAttribute(STATE_COUNT)
    var stateCount: Int = 0,
    @get:DynamoDbAttribute(STATE_TIMESTAMP)
    var stateTimestamp: Long = 0,
    @get:DynamoDbAttribute(TRACE_CONTEXT)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var traceContext: Map<String, String>? = null,
    @get:DynamoDbAttribute(UPDATED_AT)
    var updatedAt: Long = 0L,
) : Leasable {
    fun toEdcDataFlow(): EdcDataFlow =
        EdcDataFlow.Builder.newInstance().apply {
            id(id)
            callbackAddress(callbackAddress?.let { URI.create(it) })
            createdAt(createdAt)
            destination(destination?.let { DataAddress.Builder.newInstance().properties(it).build() })
            errorDetail(errorDetail)
            transferType(
                transferTypeFlow?.let {
                    TransferType(transferTypeDestination ?: "", FlowType.valueOf(it), transferTypeResponseChannel)
                },
            )
            properties(properties)
            source(source?.let { DataAddress.Builder.newInstance().properties(it).build() })
            state?.let { state(it) }
            stateCount(stateCount)
            stateTimestamp(stateTimestamp)
            traceContext(traceContext)
            updatedAt(updatedAt)
        }.build()

    companion object {
        const val CALLBACK_ADDRESS = "callbackAddress"
        const val CREATED_AT = "createdAt"
        const val DESTINATION = "destination"
        const val ERROR_DETAIL = "errorDetail"
        const val TRANSFER_TYPE_DESTINATION = "transferTypeDestination"
        const val TRANSFER_TYPE_FLOW = "transferTypeFlow"
        const val TRANSFER_TYPE_RESPONSE_CHANNEL = "transferTypeResponseChannel"
        const val LEASE_ID = "leaseId"
        const val ID = "id"
        const val PROPERTIES = "properties"
        const val SOURCE = "source"
        const val STATE = "state"
        const val STATE_COUNT = "stateCount"
        const val STATE_TIMESTAMP = "stateTimestamp"
        const val TRACE_CONTEXT = "traceContext"
        const val UPDATED_AT = "updatedAt"

        const val TABLE_NAME = "DataFlows"
    }
}

fun EdcDataFlow.toDdbDataFlow(leaseId: String? = null): DataFlow =
    DataFlow(
        id = id,
        callbackAddress = callbackAddress.toString(),
        createdAt = createdAt,
        destination = destination?.properties,
        errorDetail = errorDetail,
        transferTypeDestination = transferType?.destinationType(),
        transferTypeFlow = transferType?.flowType()?.toString(),
        transferTypeResponseChannel = transferType?.responseChannelType(),
        leaseId = leaseId,
        properties = properties,
        source = source?.properties,
        state = state,
        stateCount = stateCount,
        stateTimestamp = stateTimestamp,
        traceContext = traceContext,
        updatedAt = updatedAt,
    )
