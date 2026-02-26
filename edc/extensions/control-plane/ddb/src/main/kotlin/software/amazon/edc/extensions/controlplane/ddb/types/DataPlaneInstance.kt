// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.types

import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbConvertedBy
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.edc.extensions.common.ddb.MapStringAnyConverter
import software.amazon.edc.extensions.common.ddb.types.Leasable
import java.time.Instant
import org.eclipse.edc.connector.dataplane.selector.spi.instance.DataPlaneInstance as EdcDataPlaneInstance

@DynamoDbBean
data class DataPlaneInstance(
    @get:DynamoDbAttribute(ID)
    @get:DynamoDbPartitionKey
    var id: String = "",
    @get:DynamoDbAttribute(LEASE_ID)
    override var leaseId: String? = null,
    @get:DynamoDbAttribute(ALLOWED_SOURCE_TYPES)
    var allowedSourceTypes: Set<String>? = null,
    @get:DynamoDbAttribute(ALLOWED_TRANSFER_TYPES)
    var allowedTransferTypes: Set<String>? = null,
    @get:DynamoDbAttribute(CREATED_AT)
    var createdAt: Long = 0,
    @get:DynamoDbAttribute(ERROR_DETAIL)
    var errorDetail: String? = null,
    // Default value used by EDC version of this class
    @get:DynamoDbAttribute(LAST_ACTIVE)
    var lastActive: Long = Instant.now().toEpochMilli(),
    @get:DynamoDbAttribute(PENDING)
    var pending: Boolean = false,
    @get:DynamoDbAttribute(PROPERTIES)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var properties: Map<String, Any>? = null,
    @get:DynamoDbAttribute(STATE)
    var state: Int = 0,
    @get:DynamoDbAttribute(STATE_COUNT)
    var stateCount: Int = 0,
    @get:DynamoDbAttribute(STATE_TIMESTAMP)
    var stateTimestamp: Long = 0,
    @get:DynamoDbAttribute(UPDATED_AT)
    var updatedAt: Long = 0,
    @get:DynamoDbAttribute(URL)
    var url: String? = null,
) : Leasable {
    fun toEdcDataPlaneInstance(): EdcDataPlaneInstance =
        EdcDataPlaneInstance.Builder.newInstance().apply {
            id(id)
            allowedSourceTypes(allowedSourceTypes)
            allowedTransferType(allowedTransferTypes)
            createdAt(createdAt)
            errorDetail(errorDetail)
            lastActive(lastActive)
            pending(pending)
            properties(properties)
            state(state)
            stateCount(state)
            stateTimestamp(stateTimestamp)
            updatedAt(updatedAt)
            url(url)
        }.build()

    companion object {
        const val ALLOWED_SOURCE_TYPES = "allowedSourceTypes"
        const val ALLOWED_TRANSFER_TYPES = "allowedTransferTypes"
        const val CREATED_AT = "createdAt"
        const val ERROR_DETAIL = "errorDetail"
        const val ID = "id"
        const val LAST_ACTIVE = "lastActive"
        const val LEASE_ID = "leaseId"
        const val PENDING = "pending"
        const val PROPERTIES = "properties"
        const val STATE = "state"
        const val STATE_COUNT = "stateCount"
        const val STATE_TIMESTAMP = "stateTimestamp"
        const val UPDATED_AT = "updatedAt"
        const val URL = "url"

        const val TABLE_NAME = "DataPlaneInstances"
    }
}

fun EdcDataPlaneInstance.toDdbDataPlaneInstance(leaseId: String? = null): DataPlaneInstance =
    DataPlaneInstance(
        id = id,
        leaseId = leaseId,
        allowedSourceTypes = allowedSourceTypes?.let { if (it.isEmpty()) null else it },
        allowedTransferTypes = allowedTransferTypes?.let { if (it.isEmpty()) null else it },
        createdAt = createdAt,
        errorDetail = errorDetail,
        lastActive = lastActive,
        pending = isPending,
        properties = properties,
        state = state,
        stateCount = stateCount,
        stateTimestamp = stateTimestamp,
        updatedAt = updatedAt,
        url = url.toString(),
    )
