// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.assets

import org.eclipse.edc.connector.controlplane.asset.spi.index.AssetIndex
import org.eclipse.edc.spi.query.Criterion
import org.eclipse.edc.spi.query.CriterionOperatorRegistry
import org.eclipse.edc.spi.query.QuerySpec
import org.eclipse.edc.spi.query.SortOrder
import org.eclipse.edc.spi.result.StoreResult
import org.eclipse.edc.spi.types.domain.DataAddress
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.edc.extensions.common.ddb.utility.applyOffsetAndLimit
import software.amazon.edc.extensions.common.ddb.utility.keyFromId
import software.amazon.edc.extensions.common.ddb.utility.toPredicate
import software.amazon.edc.extensions.controlplane.ddb.types.Asset
import software.amazon.edc.extensions.controlplane.ddb.types.toDdbAsset
import java.util.stream.Stream
import kotlin.streams.asStream
import org.eclipse.edc.connector.controlplane.asset.spi.domain.Asset as EdcAsset

class DdbAssetIndex(
    private val criterionOperatorRegistry: CriterionOperatorRegistry,
    private val table: DynamoDbTable<Asset>,
) : AssetIndex {
    override fun resolveForAsset(assetId: String): DataAddress? {
//        log().info("resolveForAsset: $assetId")
        val asset = getAsset(assetId)
//        log().info("resolveForAsset: $assetId -> $asset, dataAddress=${asset?.dataAddress}")
        val converted = asset?.toEdcAsset()?.dataAddress
//        log().info("resolveForAsset: $assetId -> dataAddress=${converted?.properties}")
        return converted
    }

    override fun queryAssets(querySpec: QuerySpec): Stream<EdcAsset> {
//        log().info("query: $querySpec")

        // In order to support querying nested properties objects and the case-insensitive like operator, we need to do
        // a full table scan and perform the filtering in our application logic.
        val pages = table.scan()
        val predicate = querySpec.filterExpression.toPredicate<Any>(criterionOperatorRegistry)

        return pages
            .items()
            .asSequence()
            .map { it.toEdcAsset() }
            .filter { predicate.test(it) }
            .sortedWith(EdcAssetComparator(querySpec.sortField, querySpec.sortOrder))
            .applyOffsetAndLimit(querySpec)
            .asStream()
    }

    override fun findById(assetId: String): EdcAsset? = getAsset(assetId)?.toEdcAsset()

    override fun create(asset: EdcAsset): StoreResult<Void> {
        if (getAsset(asset.id) != null) {
            return StoreResult.alreadyExists("Asset with ID ${asset.id} already exists!")
        }
        table.putItem(asset.toDdbAsset())
        return StoreResult.success()
    }

    override fun deleteById(assetId: String): StoreResult<EdcAsset> {
        val asset = getAsset(assetId)
        if (asset != null) {
            val result = table.deleteItem(asset)
            if (result != null) {
                return StoreResult.success(result.toEdcAsset())
            }
        }
        return StoreResult.notFound("Asset with ID $assetId not found!")
    }

    override fun countAssets(criteria: List<Criterion>): Long {
        val querySpec =
            QuerySpec.Builder
                .newInstance()
                .apply {
                    filter(criteria)
                    limit(Integer.MAX_VALUE)
                }.build()
        return queryAssets(querySpec).count()
    }

    override fun updateAsset(asset: EdcAsset): StoreResult<EdcAsset> =
        if (getAsset(asset.id) == null) {
            StoreResult.notFound("Asset with ID ${asset.id} not found!")
        } else {
            StoreResult.success(table.updateItem(asset.toDdbAsset()).toEdcAsset())
        }

    private fun getAsset(id: String): Asset? = table.getItem(keyFromId(id))

    internal class EdcAssetComparator(
        private val sortField: String?,
        private val sortOrder: SortOrder,
    ) : Comparator<EdcAsset> {
        override fun compare(
            a1: EdcAsset?,
            a2: EdcAsset?,
        ): Int {
            if (sortField == null) {
                return 0
            }

            val f1 = a1?.getPropertyOrPrivate(sortField)?.asComparable()
            val f2 = a2?.getPropertyOrPrivate(sortField)?.asComparable()

            // This is how null comparison is handled in the SQL version of AssetIndex
            if (f1 == null || f2 == null) {
                throw IllegalArgumentException(
                    "Cannot sort by field $sortField, it does not exist on one or more Assets!",
                )
            }

            return if (sortOrder == SortOrder.ASC) f1.compareTo(f2) else f2.compareTo(f1)
        }

        @Suppress("UNCHECKED_CAST")
        private fun Any.asComparable(): Comparable<Any>? = if (this is Comparable<*>) this as Comparable<Any> else null
    }
}
