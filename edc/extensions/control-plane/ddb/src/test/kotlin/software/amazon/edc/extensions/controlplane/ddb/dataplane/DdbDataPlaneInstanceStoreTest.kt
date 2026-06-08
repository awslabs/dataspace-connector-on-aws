// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.dataplane

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import org.eclipse.edc.connector.dataplane.selector.spi.store.DataPlaneInstanceStore
import org.eclipse.edc.connector.dataplane.selector.spi.testfixtures.store.DataPlaneInstanceStoreTestBase
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.controlplane.ddb.TestTableHelper
import software.amazon.edc.extensions.controlplane.ddb.types.DataPlaneInstance
import java.time.Clock
import java.time.Duration

class DdbDataPlaneInstanceStoreTest : DataPlaneInstanceStoreTestBase() {
    private val ddbClient = DynamoDBEmbedded.create().dynamoDbClient()
    private val client = DynamoDbEnhancedClient.builder().dynamoDbClient(ddbClient).build()

    init {
        ddbClient.createTable(TestTableHelper.createRequest())
    }

    private val dataPlaneInstanceStore =
        DdbDataPlaneInstanceStore(
            clock = Clock.systemDefaultZone(),
            leaseHolder = CONNECTOR_NAME,
            leaseTable = client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(Lease::class.java)),
            table = client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(DataPlaneInstance::class.java)),
        )

    override fun getStore(): DataPlaneInstanceStore = dataPlaneInstanceStore

    override fun leaseEntity(
        dataPlaneInstanceId: String,
        owner: String,
        duration: Duration,
    ) {
        dataPlaneInstanceStore.acquireLease(dataPlaneInstanceId, owner, duration)
    }

    override fun isLeasedBy(
        dataPlaneInstanceId: String,
        owner: String,
    ): Boolean = dataPlaneInstanceStore.isLeasedBy(dataPlaneInstanceId, owner)
}
