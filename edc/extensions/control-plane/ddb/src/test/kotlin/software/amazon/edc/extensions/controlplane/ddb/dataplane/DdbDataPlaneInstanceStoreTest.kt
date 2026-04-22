// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.dataplane

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import org.eclipse.edc.connector.dataplane.selector.spi.store.DataPlaneInstanceStore
import org.eclipse.edc.connector.dataplane.selector.spi.testfixtures.store.DataPlaneInstanceStoreTestBase
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.controlplane.ddb.types.DataPlaneInstance
import java.time.Clock
import java.time.Duration

class DdbDataPlaneInstanceStoreTest : DataPlaneInstanceStoreTestBase() {
    private val client =
        DynamoDbEnhancedClient
            .builder()
            .dynamoDbClient(DynamoDBEmbedded.create().dynamoDbClient())
            .build()
    private val leaseTable =
        client
            .table(Lease.TABLE_NAME, TableSchema.fromBean(Lease::class.java))
            .apply { createTable() }
    private val dataPlaneInstanceTable =
        client
            .table(DataPlaneInstance.TABLE_NAME, TableSchema.fromBean(DataPlaneInstance::class.java))
            .apply { createTable() }

    private val dataPlaneInstanceStore =
        DdbDataPlaneInstanceStore(
            clock = Clock.systemDefaultZone(),
            leaseHolder = CONNECTOR_NAME,
            leaseTable = leaseTable,
            table = dataPlaneInstanceTable,
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
