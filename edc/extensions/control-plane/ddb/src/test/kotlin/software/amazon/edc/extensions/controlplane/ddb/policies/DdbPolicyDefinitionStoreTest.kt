// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.policies

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import com.fasterxml.jackson.databind.ObjectMapper
import org.eclipse.edc.connector.controlplane.policy.spi.store.PolicyDefinitionStore
import org.eclipse.edc.connector.controlplane.policy.spi.testfixtures.store.PolicyDefinitionStoreTestBase
import org.eclipse.edc.query.CriterionOperatorRegistryImpl
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.controlplane.ddb.types.PolicyDefinition

class DdbPolicyDefinitionStoreTest : PolicyDefinitionStoreTestBase() {
    private val client =
        DynamoDbEnhancedClient.builder()
            .dynamoDbClient(DynamoDBEmbedded.create().dynamoDbClient())
            .build()
    private val table =
        client.table(PolicyDefinition.TABLE_NAME, TableSchema.fromBean(PolicyDefinition::class.java))
            .apply { createTable() }

    private val policyDefinitionStore =
        DdbPolicyDefinitionStore(
            criterionOperatorRegistry = CriterionOperatorRegistryImpl.ofDefaults(),
            objectMapper = ObjectMapper(),
            table = table,
        )

    override fun getPolicyDefinitionStore(): PolicyDefinitionStore = policyDefinitionStore
}
