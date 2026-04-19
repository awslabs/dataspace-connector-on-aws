// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.ddb.types

import org.eclipse.edc.connector.dataplane.spi.AccessTokenData
import org.eclipse.edc.spi.iam.ClaimToken
import org.eclipse.edc.spi.types.domain.DataAddress
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbConvertedBy
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.edc.extensions.common.ddb.MapStringAnyConverter

@DynamoDbBean
data class AccessToken(
    @get:DynamoDbAttribute(ID)
    @get:DynamoDbPartitionKey
    var id: String = "",
    @get:DynamoDbAttribute(ADDITIONAL_PROPERTIES)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var additionalProperties: Map<String, Any> = emptyMap(),
    @get:DynamoDbAttribute(CLAIM_TOKEN)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var claimToken: Map<String, Any> = emptyMap(),
    @get:DynamoDbAttribute(DATA_ADDRESS)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var dataAddress: Map<String, Any> = emptyMap(),
) {
    fun toEdcAccessTokenData(): AccessTokenData =
        AccessTokenData(
            id,
            ClaimToken.Builder
                .newInstance()
                .claims(claimToken)
                .build(),
            DataAddress.Builder
                .newInstance()
                .properties(dataAddress)
                .build(),
            additionalProperties,
        )

    companion object {
        const val ADDITIONAL_PROPERTIES = "additionalProperties"
        const val CLAIM_TOKEN = "claimToken"
        const val DATA_ADDRESS = "dataAddress"
        const val ID = "id"

        const val TABLE_NAME = "AccessTokens"
    }
}

fun AccessTokenData.toDdbAccessToken(): AccessToken =
    AccessToken(
        id = id,
        additionalProperties = additionalProperties,
        claimToken = claimToken.claims,
        dataAddress = dataAddress.properties,
    )
