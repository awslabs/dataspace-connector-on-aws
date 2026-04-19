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
import software.amazon.edc.extensions.controlplane.ddb.types.ContractDefinition

class DdbContractDefinitionStoreTest : ContractDefinitionStoreTestBase() {
    private val client =
        DynamoDbEnhancedClient
            .builder()
            .dynamoDbClient(DynamoDBEmbedded.create().dynamoDbClient())
            .build()
    private val contractDefinitionStore =
        DdbContractDefinitionStore(
            criterionOperatorRegistry = CriterionOperatorRegistryImpl.ofDefaults(),
            objectMapper = ObjectMapper(),
            table =
                client
                    .table(ContractDefinition.TABLE_NAME, TableSchema.fromBean(ContractDefinition::class.java))
                    .apply { createTable() },
        )

    override fun getContractDefinitionStore(): ContractDefinitionStore = contractDefinitionStore
}
