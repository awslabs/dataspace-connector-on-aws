// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.contracts

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import com.fasterxml.jackson.databind.ObjectMapper
import org.eclipse.edc.connector.controlplane.contract.spi.negotiation.store.ContractNegotiationStore
import org.eclipse.edc.connector.controlplane.contract.spi.testfixtures.negotiation.store.ContractNegotiationStoreTestBase
import org.eclipse.edc.query.CriterionOperatorRegistryImpl
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.controlplane.ddb.TestTableHelper
import software.amazon.edc.extensions.controlplane.ddb.types.ContractAgreement
import software.amazon.edc.extensions.controlplane.ddb.types.ContractNegotiation
import java.time.Duration

class DdbContractNegotiationStoreTest : ContractNegotiationStoreTestBase() {
    private val ddbClient = DynamoDBEmbedded.create().dynamoDbClient()
    private val client = DynamoDbEnhancedClient.builder().dynamoDbClient(ddbClient).build()

    init {
        ddbClient.createTable(TestTableHelper.createRequest())
    }

    private val contractNegotiationStore =
        DdbContractNegotiationStore(
            clock = clock,
            contractAgreementTable = client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(ContractAgreement::class.java)),
            contractNegotiationTable = client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(ContractNegotiation::class.java)),
            criterionOperatorRegistry = CriterionOperatorRegistryImpl.ofDefaults(),
            leaseHolder = CONNECTOR_NAME,
            leaseTable = client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(Lease::class.java)),
            objectMapper = ObjectMapper(),
        )

    override fun getContractNegotiationStore(): ContractNegotiationStore = contractNegotiationStore

    override fun leaseEntity(
        negotiationId: String,
        owner: String,
        duration: Duration,
    ) {
        contractNegotiationStore.acquireLease(negotiationId, owner, duration)
    }

    override fun isLeasedBy(
        negotiationId: String,
        owner: String,
    ): Boolean = contractNegotiationStore.isLeasedBy(negotiationId, owner)
}
