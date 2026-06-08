// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.types

import org.eclipse.edc.connector.policy.monitor.spi.PolicyMonitorEntry
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSecondaryPartitionKey
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSecondarySortKey
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSortKey
import software.amazon.edc.extensions.common.ddb.EntityType
import software.amazon.edc.extensions.common.ddb.types.Leasable
import software.amazon.edc.extensions.common.ddb.utility.gsiStatePk

@DynamoDbBean
data class PolicyMonitor(
    @get:DynamoDbPartitionKey
    @get:DynamoDbAttribute("pk")
    var pk: String = EntityType.POLICY_MONITOR,
    @get:DynamoDbSortKey
    @get:DynamoDbAttribute("sk")
    var sk: String = "",
    @get:DynamoDbAttribute(CONTRACT_ID)
    var contractId: String? = null,
    @get:DynamoDbAttribute(CREATED_AT)
    var createdAt: Long = 0L,
    @get:DynamoDbAttribute(ERROR_DETAIL)
    var errorDetail: String? = null,
    @get:DynamoDbAttribute(GSI_STATE_PK)
    @get:DynamoDbSecondaryPartitionKey(indexNames = [GSI_STATE])
    var gsiStatePk: String? = null,
    @get:DynamoDbAttribute(LEASE_ID)
    override var leaseId: String? = null,
    @get:DynamoDbAttribute(STATE)
    var state: Int = 0,
    @get:DynamoDbAttribute(STATE_COUNT)
    var stateCount: Int = 0,
    @get:DynamoDbAttribute(STATE_TIMESTAMP)
    @get:DynamoDbSecondarySortKey(indexNames = [GSI_STATE])
    var stateTimestamp: Long = 0,
    @get:DynamoDbAttribute(TRACE_CONTEXT)
    var traceContext: Map<String, String>? = null,
    @get:DynamoDbAttribute(UPDATED_AT)
    var updatedAt: Long = 0L,
) : Leasable {
    val id: String get() = sk

    fun toEdcPolicyMonitor(): PolicyMonitorEntry =
        PolicyMonitorEntry.Builder
            .newInstance()
            .apply {
                id(sk)
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
        const val GSI_STATE_PK = "gsiStatePk"
        const val LEASE_ID = "leaseId"
        const val STATE = "state"
        const val STATE_COUNT = "stateCount"
        const val STATE_TIMESTAMP = "stateTimestamp"
        const val TRACE_CONTEXT = "traceContext"
        const val UPDATED_AT = "updatedAt"

        const val GSI_STATE = "gsi-state"
    }
}

fun PolicyMonitorEntry.toDdbPolicyMonitor(leaseId: String? = null): PolicyMonitor =
    PolicyMonitor(
        pk = EntityType.POLICY_MONITOR,
        sk = id,
        contractId = contractId,
        createdAt = createdAt,
        errorDetail = errorDetail,
        gsiStatePk = gsiStatePk(EntityType.POLICY_MONITOR, state),
        leaseId = leaseId,
        state = state,
        stateCount = stateCount,
        stateTimestamp = stateTimestamp,
        traceContext = traceContext,
        updatedAt = updatedAt,
    )
