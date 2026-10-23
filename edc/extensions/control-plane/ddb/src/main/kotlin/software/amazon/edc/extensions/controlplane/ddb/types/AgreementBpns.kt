// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.types

import org.eclipse.tractusx.edc.agreements.bpns.spi.types.AgreementsBpnsEntry
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSortKey
import software.amazon.edc.extensions.common.ddb.EntityType

@DynamoDbBean
data class AgreementBpns(
    @get:DynamoDbPartitionKey
    @get:DynamoDbAttribute("pk")
    var pk: String = EntityType.AGREEMENT_BPNS,
    @get:DynamoDbSortKey
    @get:DynamoDbAttribute("sk")
    var sk: String = "",
    @get:DynamoDbAttribute(PROVIDER_BPN)
    var providerBpn: String = "",
    @get:DynamoDbAttribute(CONSUMER_BPN)
    var consumerBpn: String = "",
) {
    companion object {
        const val PROVIDER_BPN = "providerBpn"
        const val CONSUMER_BPN = "consumerBpn"
    }
}

fun AgreementsBpnsEntry.toDdbAgreementBpns(): AgreementBpns =
    AgreementBpns(sk = agreementId, providerBpn = providerBpn, consumerBpn = consumerBpn)
