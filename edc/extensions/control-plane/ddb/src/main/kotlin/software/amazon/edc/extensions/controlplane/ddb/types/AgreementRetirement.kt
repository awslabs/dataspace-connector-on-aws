// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.types

import org.eclipse.tractusx.edc.agreements.retirement.spi.types.AgreementsRetirementEntry
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSortKey
import software.amazon.edc.extensions.common.ddb.EntityType

@DynamoDbBean
data class AgreementRetirement(
    @get:DynamoDbPartitionKey
    @get:DynamoDbAttribute("pk")
    var pk: String = EntityType.AGREEMENT_RETIREMENT,
    @get:DynamoDbSortKey
    @get:DynamoDbAttribute("sk")
    var sk: String = "",
    @get:DynamoDbAttribute(REASON)
    var reason: String = "",
    @get:DynamoDbAttribute(RETIREMENT_DATE)
    var agreementRetirementDate: Long = 0L,
) {
    fun toEdcEntry(): AgreementsRetirementEntry =
        AgreementsRetirementEntry.Builder
            .newInstance()
            .withAgreementId(sk)
            .withReason(reason)
            .withAgreementRetirementDate(agreementRetirementDate)
            .build()

    companion object {
        const val REASON = "reason"
        const val RETIREMENT_DATE = "agreementRetirementDate"
    }
}

fun AgreementsRetirementEntry.toDdbAgreementRetirement(): AgreementRetirement =
    AgreementRetirement(
        sk = agreementId,
        reason = reason,
        agreementRetirementDate = agreementRetirementDate,
    )
