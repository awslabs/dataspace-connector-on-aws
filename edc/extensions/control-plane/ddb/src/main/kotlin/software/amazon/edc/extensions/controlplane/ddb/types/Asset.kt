// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.types

import org.eclipse.edc.spi.types.domain.DataAddress
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbConvertedBy
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSortKey
import software.amazon.edc.extensions.common.ddb.EntityType
import software.amazon.edc.extensions.common.ddb.MapStringAnyConverter
import org.eclipse.edc.connector.controlplane.asset.spi.domain.Asset as EdcAsset

@DynamoDbBean
data class Asset(
    @get:DynamoDbPartitionKey
    @get:DynamoDbAttribute("pk")
    var pk: String = EntityType.ASSET,
    @get:DynamoDbSortKey
    @get:DynamoDbAttribute("sk")
    var sk: String = "",
    @get:DynamoDbAttribute(CREATED_AT)
    var createdAt: Long = 0L,
    @get:DynamoDbAttribute(DATA_ADDRESS)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var dataAddress: Map<String, Any> = emptyMap(),
    @get:DynamoDbAttribute(PRIVATE_PROPERTIES)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var privateProperties: Map<String, Any> = emptyMap(),
    @get:DynamoDbAttribute(PROPERTIES)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var properties: Map<String, Any> = emptyMap(),
) {
    val assetId: String get() = sk

    fun toEdcAsset(): EdcAsset =
        EdcAsset.Builder
            .newInstance()
            .apply {
                id(sk)
                createdAt(createdAt)
                dataAddress(
                    DataAddress.Builder
                        .newInstance()
                        .properties(dataAddress)
                        .build(),
                )
                privateProperties(privateProperties)
                properties(properties)
            }.build()

    companion object {
        const val CREATED_AT = "createdAt"
        const val DATA_ADDRESS = "dataAddress"
        const val PRIVATE_PROPERTIES = "privateProperties"
        const val PROPERTIES = "properties"
    }
}

fun EdcAsset.toDdbAsset(): Asset =
    Asset(
        pk = EntityType.ASSET,
        sk = id,
        createdAt = createdAt,
        dataAddress = dataAddress?.properties ?: emptyMap(),
        privateProperties = privateProperties ?: emptyMap(),
        properties = properties ?: emptyMap(),
    )
