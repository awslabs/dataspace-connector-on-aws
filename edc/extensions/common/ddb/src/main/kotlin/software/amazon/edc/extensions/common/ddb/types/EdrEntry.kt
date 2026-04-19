// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb.types

import org.eclipse.edc.edr.spi.types.EndpointDataReferenceEntry
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey

@DynamoDbBean
data class EdrEntry(
    @get:DynamoDbPartitionKey
    @get:DynamoDbAttribute(ID)
    var transferProcessId: String = "",
    @get:DynamoDbAttribute(CREATED_AT)
    var createdAt: Long = 0L,
    @get:DynamoDbAttribute(AGREEMENT_ID)
    var agreementId: String = "",
    @get:DynamoDbAttribute(ASSET_ID)
    var assetId: String = "",
    @get:DynamoDbAttribute(CONTRACT_NEGOTIATION_ID)
    var contractNegotiationId: String? = null,
    @get:DynamoDbAttribute(PROVIDER_ID)
    var providerId: String = "",
) {
    fun toEdcType(): EndpointDataReferenceEntry =
        EndpointDataReferenceEntry.Builder
            .newInstance()
            .apply {
                transferProcessId(transferProcessId)
                agreementId(agreementId)
                assetId(assetId)
                contractNegotiationId(contractNegotiationId)
                createdAt(createdAt)
                providerId(providerId)
            }.build()

    companion object {
        const val AGREEMENT_ID = "agreementId"
        const val ASSET_ID = "assetId"
        const val CONTRACT_NEGOTIATION_ID = "contractNegotiationId"
        const val CREATED_AT = "createdAt"
        const val ID = "id"
        const val PROVIDER_ID = "providerId"

        const val TABLE_NAME = "EdrEntries"
    }
}

fun EndpointDataReferenceEntry.toDdbEdrEntry(): EdrEntry =
    EdrEntry(
        transferProcessId = transferProcessId,
        agreementId = agreementId,
        assetId = assetId,
        contractNegotiationId = contractNegotiationId,
        createdAt = createdAt,
        providerId = providerId,
    )
