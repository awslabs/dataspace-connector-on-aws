// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb

/**
 * Entity type identifiers for the single-table DynamoDB design.
 * Each entity type maps to what was previously a separate table.
 */
object EntityType {
    const val ACCESS_TOKEN = "AccessToken"
    const val ASSET = "Asset"
    const val BPN_GROUP = "BpnGroup"
    const val CONTRACT_AGREEMENT = "ContractAgreement"
    const val CONTRACT_DEFINITION = "ContractDefinition"
    const val CONTRACT_NEGOTIATION = "ContractNegotiation"
    const val DATA_FLOW = "DataFlow"
    const val DATA_PLANE_INSTANCE = "DataPlaneInstance"
    const val EDR_ENTRY = "EdrEntry"
    const val LEASE = "Lease"
    const val POLICY_DEFINITION = "PolicyDefinition"
    const val POLICY_MONITOR = "PolicyMonitor"
    const val TRANSFER_PROCESS = "TransferProcess"
}

/** Environment variable / EDC config key for the DynamoDB table name. */
const val EDC_DDB_TABLE_NAME_SETTING = "edc.ddb.table.name"

/** Buffer added to TTL epoch (in seconds) to ensure DynamoDB deletes items after they've fully expired. */
const val TTL_BUFFER_SECONDS = 3600L
