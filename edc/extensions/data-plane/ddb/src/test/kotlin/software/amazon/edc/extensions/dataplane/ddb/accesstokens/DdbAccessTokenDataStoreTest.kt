// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.ddb.accesstokens

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import org.eclipse.edc.connector.dataplane.spi.store.AccessTokenDataStore
import org.eclipse.edc.connector.dataplane.spi.store.AccessTokenDataTestBase
import org.eclipse.edc.query.CriterionOperatorRegistryImpl
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.dataplane.ddb.TestTableHelper
import software.amazon.edc.extensions.dataplane.ddb.types.AccessToken

class DdbAccessTokenDataStoreTest : AccessTokenDataTestBase() {
    private val ddbClient = DynamoDBEmbedded.create().dynamoDbClient()
    private val client = DynamoDbEnhancedClient.builder().dynamoDbClient(ddbClient).build()

    init {
        ddbClient.createTable(TestTableHelper.createRequest())
    }

    private val accessTokenIndex =
        DdbAccessTokenDataStore(
            criterionOperatorRegistry = CriterionOperatorRegistryImpl.ofDefaults(),
            table = client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(AccessToken::class.java)),
            tokenExpirySeconds = 300,
        )

    override fun getStore(): AccessTokenDataStore = accessTokenIndex
}
