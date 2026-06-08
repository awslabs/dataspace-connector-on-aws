// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.ddb.store

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.eclipse.edc.connector.dataplane.spi.store.DataPlaneStore
import org.eclipse.edc.connector.dataplane.spi.testfixtures.store.DataPlaneStoreTestBase
import org.eclipse.edc.query.CriterionOperatorRegistryImpl
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.dataplane.ddb.TestTableHelper
import software.amazon.edc.extensions.dataplane.ddb.types.DataFlow
import java.time.Clock
import java.time.Duration

class DdbDataPlaneStoreTest : DataPlaneStoreTestBase() {
    private val ddbClient = DynamoDBEmbedded.create().dynamoDbClient()
    private val client = DynamoDbEnhancedClient.builder().dynamoDbClient(ddbClient).build()

    init {
        ddbClient.createTable(TestTableHelper.createRequest())
    }

    private val dataPlaneStore =
        DdbDataPlaneStore(
            clock = Clock.systemDefaultZone(),
            criterionOperatorRegistry = CriterionOperatorRegistryImpl.ofDefaults(),
            leaseHolder = CONNECTOR_NAME,
            leaseTable = client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(Lease::class.java)),
            objectMapper = jacksonObjectMapper().apply {
                configure(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
            },
            table = client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(DataFlow::class.java)),
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
