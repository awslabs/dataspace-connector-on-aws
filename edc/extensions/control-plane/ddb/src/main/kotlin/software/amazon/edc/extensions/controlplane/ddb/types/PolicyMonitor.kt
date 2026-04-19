// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.types

import org.eclipse.edc.connector.policy.monitor.spi.PolicyMonitorEntry
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.edc.extensions.common.ddb.types.Leasable

@DynamoDbBean
data class PolicyMonitor(
    @get:DynamoDbAttribute(ID)
    @get:DynamoDbPartitionKey
    var id: String = "",
    @get:DynamoDbAttribute(CONTRACT_ID)
    var contractId: String? = null,
    @get:DynamoDbAttribute(CREATED_AT)
    var createdAt: Long = 0L,
    @get:DynamoDbAttribute(ERROR_DETAIL)
    var errorDetail: String? = null,
    @get:DynamoDbAttribute(LEASE_ID)
    override var leaseId: String? = null,
    @get:DynamoDbAttribute(STATE)
    var state: Int = 0,
    @get:DynamoDbAttribute(STATE_COUNT)
    var stateCount: Int = 0,
    @get:DynamoDbAttribute(STATE_TIMESTAMP)
    var stateTimestamp: Long = 0,
    @get:DynamoDbAttribute(TRACE_CONTEXT)
    var traceContext: Map<String, String>? = null,
    @get:DynamoDbAttribute(UPDATED_AT)
    var updatedAt: Long = 0L,
) : Leasable {
    fun toEdcPolicyMonitor(): PolicyMonitorEntry =
        PolicyMonitorEntry.Builder
            .newInstance()
            .apply {
                id(id)
                contractId(contractId)
                createdAt(createdAt)
                errorDetail(errorDetail)
                state(state)
                stateCount(stateCount)
                stateTimestamp(stateTimestamp)
                traceContext(traceContext)
                updatedAt(updatedAt)
            }.build()

    companion object {
        const val CONTRACT_ID = "contractId"
        const val CREATED_AT = "createdAt"
        const val ERROR_DETAIL = "errorDetail"
        const val ID = "id"
        const val LEASE_ID = "leaseId"
        const val STATE = "state"
        const val STATE_COUNT = "stateCount"
        const val STATE_TIMESTAMP = "stateTimestamp"
        const val TRACE_CONTEXT = "traceContext"
        const val UPDATED_AT = "updatedAt"

        const val TABLE_NAME = "PolicyMonitors"
    }
}

fun PolicyMonitorEntry.toDdbPolicyMonitor(leaseId: String? = null): PolicyMonitor =
    PolicyMonitor(
        id = id,
        contractId = contractId,
        createdAt = createdAt,
        errorDetail = errorDetail,
        leaseId = leaseId,
        state = state,
        stateCount = stateCount,
        stateTimestamp = stateTimestamp,
        traceContext = traceContext,
        updatedAt = updatedAt,
    )
