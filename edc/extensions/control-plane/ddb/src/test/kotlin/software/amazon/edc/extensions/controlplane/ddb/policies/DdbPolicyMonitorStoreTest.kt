// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.policies

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import org.eclipse.edc.connector.policy.monitor.spi.PolicyMonitorStore
import org.eclipse.edc.connector.policy.monitor.spi.testfixtures.store.PolicyMonitorStoreTestBase
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.controlplane.ddb.types.PolicyMonitor
import java.time.Clock
import java.time.Duration

class DdbPolicyMonitorStoreTest : PolicyMonitorStoreTestBase() {
    private val client =
        DynamoDbEnhancedClient.builder()
            .dynamoDbClient(DynamoDBEmbedded.create().dynamoDbClient())
            .build()
    private val leaseTable =
        client.table(Lease.TABLE_NAME, TableSchema.fromBean(Lease::class.java))
            .apply { createTable() }
    private val policyMonitorTable =
        client.table(PolicyMonitor.TABLE_NAME, TableSchema.fromBean(PolicyMonitor::class.java)).apply { createTable() }

    private val policyMonitorStore =
        DdbPolicyMonitorStore(
            clock = Clock.systemDefaultZone(),
            leaseHolder = CONNECTOR_NAME,
            leaseTable = leaseTable,
            table = policyMonitorTable,
        )

    override fun getStore(): PolicyMonitorStore = policyMonitorStore

    override fun leaseEntity(
        policyMonitorId: String,
        owner: String,
        duration: Duration,
    ) {
        policyMonitorStore.acquireLease(policyMonitorId, owner, duration)
    }

    override fun isLeasedBy(
        policyMonitorId: String,
        owner: String,
    ): Boolean = policyMonitorStore.isLeasedBy(policyMonitorId, owner)
}
