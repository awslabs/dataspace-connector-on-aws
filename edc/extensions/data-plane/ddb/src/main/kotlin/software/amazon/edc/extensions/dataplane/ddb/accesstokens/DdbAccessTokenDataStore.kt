// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.ddb.accesstokens

import org.eclipse.edc.connector.dataplane.spi.AccessTokenData
import org.eclipse.edc.connector.dataplane.spi.store.AccessTokenDataStore
import org.eclipse.edc.spi.query.CriterionOperatorRegistry
import org.eclipse.edc.spi.query.QuerySpec
import org.eclipse.edc.spi.result.StoreResult
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.edc.extensions.common.ddb.utility.applyOffsetAndLimit
import software.amazon.edc.extensions.common.ddb.utility.getGenericPropertyComparator
import software.amazon.edc.extensions.common.ddb.utility.toPredicate
import software.amazon.edc.extensions.dataplane.ddb.types.AccessToken
import software.amazon.edc.extensions.dataplane.ddb.types.toDdbAccessToken

class DdbAccessTokenDataStore(
    private val criterionOperatorRegistry: CriterionOperatorRegistry,
    private val table: DynamoDbTable<AccessToken>,
) : AccessTokenDataStore {
    override fun getById(id: String): AccessTokenData? = table.getItem(Key.builder().partitionValue(id).build())?.toEdcAccessTokenData()

    override fun store(accessTokenData: AccessTokenData): StoreResult<Void> =
        if (getById(accessTokenData.id()) == null) {
            table.putItem(accessTokenData.toDdbAccessToken())
            StoreResult.success()
        } else {
            StoreResult.alreadyExists("AccessTokenData with ID '${accessTokenData.id}' already exists.")
        }

    override fun update(accessTokenData: AccessTokenData): StoreResult<Void> =
        if (getById(accessTokenData.id()) == null) {
            StoreResult.notFound("Access token with ID ${accessTokenData.id} does not exist!")
        } else {
            table.updateItem(accessTokenData.toDdbAccessToken())
            StoreResult.success()
        }

    override fun deleteById(id: String): StoreResult<Void> =
        if (getById(id) == null) {
            StoreResult.notFound("AccessTokenData with ID '$id' does not exist.")
        } else {
            table.deleteItem(Key.builder().partitionValue(id).build())
            StoreResult.success()
        }

    override fun query(querySpec: QuerySpec): MutableCollection<AccessTokenData> {
//        log().info("query: $querySpec")

        val pages = table.scan()
        val predicate = querySpec.filterExpression.toPredicate<Any>(criterionOperatorRegistry)
        val comparator = querySpec.getGenericPropertyComparator<Any>()

        return pages.items()
            .asSequence()
            .map { it.toEdcAccessTokenData() }
            .filter { predicate.test(it) }
            .sortedWith(comparator)
            .applyOffsetAndLimit(querySpec)
            .toMutableList()
    }
}
