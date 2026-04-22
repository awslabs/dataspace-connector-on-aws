// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.ddb.accesstokens

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import org.eclipse.edc.connector.dataplane.spi.store.AccessTokenDataStore
import org.eclipse.edc.connector.dataplane.spi.store.AccessTokenDataTestBase
import org.eclipse.edc.query.CriterionOperatorRegistryImpl
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.dataplane.ddb.types.AccessToken

class DdbAccessTokenDataStoreTest : AccessTokenDataTestBase() {
    private val client =
        DynamoDbEnhancedClient
            .builder()
            .dynamoDbClient(DynamoDBEmbedded.create().dynamoDbClient())
            .build()
    private val table =
        client
            .table(AccessToken.TABLE_NAME, TableSchema.fromBean(AccessToken::class.java))
            .apply { createTable() }

    private val accessTokenIndex =
        DdbAccessTokenDataStore(
            criterionOperatorRegistry = CriterionOperatorRegistryImpl.ofDefaults(),
            table = table,
        )

    override fun getStore(): AccessTokenDataStore = accessTokenIndex
}
