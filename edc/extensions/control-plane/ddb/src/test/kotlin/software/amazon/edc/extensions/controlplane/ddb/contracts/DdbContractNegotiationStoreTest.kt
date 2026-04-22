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
import software.amazon.edc.extensions.controlplane.ddb.types.ContractAgreement
import software.amazon.edc.extensions.controlplane.ddb.types.ContractNegotiation
import java.time.Duration

class DdbContractNegotiationStoreTest : ContractNegotiationStoreTestBase() {
    private val client =
        DynamoDbEnhancedClient
            .builder()
            .dynamoDbClient(DynamoDBEmbedded.create().dynamoDbClient())
            .build()
    private val contractAgreementTable =
        client
            .table(
                ContractAgreement.TABLE_NAME,
                TableSchema.fromBean(ContractAgreement::class.java),
            ).apply { createTable() }
    private val contractNegotiationTable =
        client
            .table(
                ContractNegotiation.TABLE_NAME,
                TableSchema.fromBean(ContractNegotiation::class.java),
            ).apply { createTable() }
    private val leaseTable =
        client
            .table(Lease.TABLE_NAME, TableSchema.fromBean(Lease::class.java))
            .apply { createTable() }

    private val contractNegotiationStore =
        DdbContractNegotiationStore(
            clock = clock,
            contractAgreementTable = contractAgreementTable,
            contractNegotiationTable = contractNegotiationTable,
            criterionOperatorRegistry = CriterionOperatorRegistryImpl.ofDefaults(),
            leaseHolder = CONNECTOR_NAME,
            leaseTable = leaseTable,
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
