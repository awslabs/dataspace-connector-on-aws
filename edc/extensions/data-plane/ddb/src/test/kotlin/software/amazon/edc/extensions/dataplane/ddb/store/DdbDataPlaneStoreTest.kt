// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.ddb.store

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import org.eclipse.edc.connector.dataplane.spi.store.DataPlaneStore
import org.eclipse.edc.connector.dataplane.spi.testfixtures.store.DataPlaneStoreTestBase
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.dataplane.ddb.types.DataFlow
import java.time.Clock
import java.time.Duration

class DdbDataPlaneStoreTest : DataPlaneStoreTestBase() {
    private val client =
        DynamoDbEnhancedClient.builder()
            .dynamoDbClient(DynamoDBEmbedded.create().dynamoDbClient())
            .build()
    private val dataFlowTable =
        client.table(DataFlow.TABLE_NAME, TableSchema.fromBean(DataFlow::class.java))
            .apply { createTable() }
    private val leaseTable =
        client.table(Lease.TABLE_NAME, TableSchema.fromBean(Lease::class.java))
            .apply { createTable() }

    private val dataPlaneStore =
        DdbDataPlaneStore(
            clock = Clock.systemDefaultZone(),
            leaseHolder = CONNECTOR_NAME,
            leaseTable = leaseTable,
            table = dataFlowTable,
        )

    override fun getStore(): DataPlaneStore = dataPlaneStore

    override fun leaseEntity(
        dataFlowId: String,
        owner: String,
        duration: Duration,
    ) {
        dataPlaneStore.acquireLease(dataFlowId, owner, duration)
    }

    override fun isLeasedBy(
        dataFlowId: String,
        owner: String,
    ): Boolean = dataPlaneStore.isLeasedBy(dataFlowId, owner)
}
