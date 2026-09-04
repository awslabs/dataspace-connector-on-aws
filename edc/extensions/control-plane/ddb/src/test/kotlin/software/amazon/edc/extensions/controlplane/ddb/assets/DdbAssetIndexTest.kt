// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.assets

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.eclipse.edc.connector.controlplane.asset.spi.index.AssetIndex
import org.eclipse.edc.connector.controlplane.asset.spi.testfixtures.AssetIndexTestBase
import org.eclipse.edc.connector.controlplane.query.asset.AssetPropertyLookup
import org.eclipse.edc.query.CriterionOperatorRegistryImpl
import org.eclipse.edc.spi.query.SortOrder
import org.eclipse.edc.spi.types.domain.DataAddress
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.controlplane.ddb.TestTableHelper
import software.amazon.edc.extensions.controlplane.ddb.types.Asset
import software.amazon.edc.extensions.controlplane.ddb.types.toDdbAsset
import org.eclipse.edc.connector.controlplane.asset.spi.domain.Asset as EdcAsset

class DdbAssetIndexTest : AssetIndexTestBase() {
    private val ddbClient = DynamoDBEmbedded.create().dynamoDbClient()
    private val client = DynamoDbEnhancedClient.builder().dynamoDbClient(ddbClient).build()

    init {
        ddbClient.createTable(TestTableHelper.createRequest())
    }

    private val table = client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(Asset::class.java))
    private val objectMapper = jacksonObjectMapper()

    private val assetIndex =
        DdbAssetIndex(
            criterionOperatorRegistry =
                CriterionOperatorRegistryImpl
                    .ofDefaults()
                    .apply { registerPropertyLookup(AssetPropertyLookup()) },
            objectMapper = objectMapper,
            table = table,
        )

    override fun getAssetIndex(): AssetIndex = assetIndex

    private fun createAsset(id: String): EdcAsset =
        EdcAsset.Builder
            .newInstance()
            .id(id)
            .dataAddress(
                DataAddress.Builder
                    .newInstance()
                    .type("test")
                    .build(),
            ).build()

    @Test
    fun comparatorThrowsExceptionWhenSortFieldIsNull() {
        val sortField = "sortField"
        val comparator = DdbAssetIndex.EdcAssetComparator(sortField, SortOrder.DESC)
        val asset1 = createAsset("A1").toDdbAsset(objectMapper)
        val asset2 = createAsset("A2").toDdbAsset(objectMapper)

        assertThrows<IllegalArgumentException> { comparator.compare(asset1.toEdcAsset(objectMapper), asset2.toEdcAsset(objectMapper)) }
        assertThrows<IllegalArgumentException> {
            comparator.compare(
                asset1.copy(properties = mapOf(sortField to "fieldValue")).toEdcAsset(objectMapper),
                asset2.toEdcAsset(objectMapper),
            )
        }
        assertThrows<IllegalArgumentException> {
            comparator.compare(
                asset1.toEdcAsset(objectMapper),
                asset2.copy(properties = mapOf(sortField to "fieldValue")).toEdcAsset(objectMapper),
            )
        }
    }
}
