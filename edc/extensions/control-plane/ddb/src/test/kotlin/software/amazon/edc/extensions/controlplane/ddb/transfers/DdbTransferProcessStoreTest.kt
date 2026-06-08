// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.transfers

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.eclipse.edc.connector.controlplane.transfer.spi.store.TransferProcessStore
import org.eclipse.edc.connector.controlplane.transfer.spi.testfixtures.store.TestFunctions
import org.eclipse.edc.connector.controlplane.transfer.spi.testfixtures.store.TransferProcessStoreTestBase
import org.eclipse.edc.query.CriterionOperatorRegistryImpl
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.controlplane.ddb.TestTableHelper
import software.amazon.edc.extensions.controlplane.ddb.types.TransferProcess
import java.time.Duration

class DdbTransferProcessStoreTest : TransferProcessStoreTestBase() {
    private val ddbClient = DynamoDBEmbedded.create().dynamoDbClient()
    private val client = DynamoDbEnhancedClient.builder().dynamoDbClient(ddbClient).build()

    init {
        ddbClient.createTable(TestTableHelper.createRequest())
    }

    private val transferProcessStore =
        DdbTransferProcessStore(
            clock = clock,
            leaseHolder = CONNECTOR_NAME,
            leaseTable = client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(Lease::class.java)),
            criterionOperatorRegistry = CriterionOperatorRegistryImpl.ofDefaults(),
            objectMapper =
                jacksonObjectMapper().apply {
                    registerSubtypes(
                        TestFunctions.TestProvisionedResource::class.java,
                        TestFunctions.TestResourceDef::class.java,
                    )
                },
            table = client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(TransferProcess::class.java)),
        )

    override fun getTransferProcessStore(): TransferProcessStore = transferProcessStore

    override fun leaseEntity(
        transferProcessId: String,
        owner: String,
        duration: Duration,
    ) {
        transferProcessStore.acquireLease(transferProcessId, owner, duration)
    }

    override fun isLeasedBy(
        transferProcessId: String,
        owner: String,
    ): Boolean = transferProcessStore.isLeasedBy(transferProcessId, owner)
}
