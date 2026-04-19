// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.assets

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import org.eclipse.edc.connector.controlplane.asset.spi.index.AssetIndex
import org.eclipse.edc.connector.controlplane.asset.spi.testfixtures.AssetIndexTestBase
import org.eclipse.edc.connector.controlplane.query.asset.AssetPropertyLookup
import org.eclipse.edc.query.CriterionOperatorRegistryImpl
import org.eclipse.edc.spi.query.SortOrder
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.controlplane.ddb.types.Asset
import software.amazon.edc.extensions.controlplane.ddb.types.toDdbAsset

class DdbAssetIndexTest : AssetIndexTestBase() {
    private val client =
        DynamoDbEnhancedClient
            .builder()
            .dynamoDbClient(DynamoDBEmbedded.create().dynamoDbClient())
            .build()
    private val table = client.table(Asset.TABLE_NAME, TableSchema.fromBean(Asset::class.java)).apply { createTable() }
    private val assetIndex =
        DdbAssetIndex(
            criterionOperatorRegistry =
                CriterionOperatorRegistryImpl
                    .ofDefaults()
                    .apply { registerPropertyLookup(AssetPropertyLookup()) },
            table = table,
        )

    override fun getAssetIndex(): AssetIndex = assetIndex

    @Test
    fun comparatorThrowsExceptionWhenSortFieldIsNull() {
        val sortField = "sortField"
        val comparator = DdbAssetIndex.EdcAssetComparator(sortField, SortOrder.DESC)
        val asset1 = createAsset("A1").toDdbAsset()
        val asset2 = createAsset("A2").toDdbAsset()

        assertThrows<IllegalArgumentException> { comparator.compare(asset1.toEdcAsset(), asset2.toEdcAsset()) }
        assertThrows<IllegalArgumentException> {
            comparator.compare(
                asset1.copy(properties = mapOf(sortField to "fieldValue")).toEdcAsset(),
                asset2.toEdcAsset(),
            )
        }
        assertThrows<IllegalArgumentException> {
            comparator.compare(
                asset1.toEdcAsset(),
                asset2.copy(properties = mapOf(sortField to "fieldValue")).toEdcAsset(),
            )
        }
    }
}
