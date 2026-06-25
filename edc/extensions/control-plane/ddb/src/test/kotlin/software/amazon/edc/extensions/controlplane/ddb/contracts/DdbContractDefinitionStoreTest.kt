// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.contracts

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import com.fasterxml.jackson.databind.ObjectMapper
import org.eclipse.edc.connector.controlplane.contract.spi.offer.store.ContractDefinitionStore
import org.eclipse.edc.connector.controlplane.contract.spi.testfixtures.offer.store.ContractDefinitionStoreTestBase
import org.eclipse.edc.query.CriterionOperatorRegistryImpl
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.controlplane.ddb.TestTableHelper
import software.amazon.edc.extensions.controlplane.ddb.types.ContractDefinition

class DdbContractDefinitionStoreTest : ContractDefinitionStoreTestBase() {
    private val ddbClient = DynamoDBEmbedded.create().dynamoDbClient()
    private val client = DynamoDbEnhancedClient.builder().dynamoDbClient(ddbClient).build()

    init {
        ddbClient.createTable(TestTableHelper.createRequest())
    }

    private val contractDefinitionStore =
        DdbContractDefinitionStore(
            criterionOperatorRegistry = CriterionOperatorRegistryImpl.ofDefaults(),
            objectMapper = ObjectMapper(),
            table = client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(ContractDefinition::class.java)),
        )

    override fun getContractDefinitionStore(): ContractDefinitionStore = contractDefinitionStore
}
