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
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSortKey
import software.amazon.edc.extensions.common.ddb.EntityType
import software.amazon.edc.extensions.common.ddb.MapStringAnyConverter
import software.amazon.edc.extensions.common.ddb.TTL_BUFFER_SECONDS

@DynamoDbBean
data class AccessToken(
    @get:DynamoDbPartitionKey
    @get:DynamoDbAttribute("pk")
    var pk: String = EntityType.ACCESS_TOKEN,
    @get:DynamoDbSortKey
    @get:DynamoDbAttribute("sk")
    var sk: String = "",
    @get:DynamoDbAttribute(ADDITIONAL_PROPERTIES)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var additionalProperties: Map<String, Any> = emptyMap(),
    @get:DynamoDbAttribute(CLAIM_TOKEN)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var claimToken: Map<String, Any> = emptyMap(),
    @get:DynamoDbAttribute(DATA_ADDRESS)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var dataAddress: Map<String, Any> = emptyMap(),
    @get:DynamoDbAttribute("ttl")
    var ttl: Long? = null,
) {
    val id: String get() = sk

    fun toEdcAccessTokenData(): AccessTokenData =
        AccessTokenData(
            sk,
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
    }
}

fun AccessTokenData.toDdbAccessToken(tokenExpirySeconds: Long): AccessToken =
    AccessToken(
        pk = EntityType.ACCESS_TOKEN,
        sk = id,
        additionalProperties = additionalProperties,
        claimToken = claimToken.claims,
        dataAddress = dataAddress.properties,
        ttl = System.currentTimeMillis() / 1000 + tokenExpirySeconds + TTL_BUFFER_SECONDS,
    )
