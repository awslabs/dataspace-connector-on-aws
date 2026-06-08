// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb.edr

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import org.eclipse.edc.edr.spi.store.EndpointDataReferenceEntryIndex
import org.eclipse.edc.edr.spi.store.EndpointDataReferenceEntryIndexTestBase
import org.eclipse.edc.query.CriterionOperatorRegistryImpl
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.services.dynamodb.model.AttributeDefinition
import software.amazon.awssdk.services.dynamodb.model.BillingMode
import software.amazon.awssdk.services.dynamodb.model.CreateTableRequest
import software.amazon.awssdk.services.dynamodb.model.GlobalSecondaryIndex
import software.amazon.awssdk.services.dynamodb.model.KeySchemaElement
import software.amazon.awssdk.services.dynamodb.model.KeyType
import software.amazon.awssdk.services.dynamodb.model.Projection
import software.amazon.awssdk.services.dynamodb.model.ProjectionType
import software.amazon.awssdk.services.dynamodb.model.ScalarAttributeType
import software.amazon.edc.extensions.common.ddb.types.EdrEntry

class DdbEdrEntryIndexTest : EndpointDataReferenceEntryIndexTestBase() {
    companion object {
        const val TABLE_NAME = "test-table"
    }

    private val ddbClient = DynamoDBEmbedded.create().dynamoDbClient()
    private val client = DynamoDbEnhancedClient.builder().dynamoDbClient(ddbClient).build()

    init {
        ddbClient.createTable(
            CreateTableRequest.builder()
                .tableName(TABLE_NAME)
                .billingMode(BillingMode.PAY_PER_REQUEST)
                .keySchema(
                    KeySchemaElement.builder().attributeName("pk").keyType(KeyType.HASH).build(),
                    KeySchemaElement.builder().attributeName("sk").keyType(KeyType.RANGE).build(),
                )
                .attributeDefinitions(
                    AttributeDefinition.builder().attributeName("pk").attributeType(ScalarAttributeType.S).build(),
                    AttributeDefinition.builder().attributeName("sk").attributeType(ScalarAttributeType.S).build(),
                    AttributeDefinition.builder().attributeName("gsiStatePk").attributeType(ScalarAttributeType.S).build(),
                    AttributeDefinition.builder().attributeName("stateTimestamp").attributeType(ScalarAttributeType.N).build(),
                    AttributeDefinition.builder().attributeName("correlationId").attributeType(ScalarAttributeType.S).build(),
                )
                .globalSecondaryIndexes(
                    GlobalSecondaryIndex.builder()
                        .indexName("gsi-state")
                        .keySchema(
                            KeySchemaElement.builder().attributeName("gsiStatePk").keyType(KeyType.HASH).build(),
                            KeySchemaElement.builder().attributeName("stateTimestamp").keyType(KeyType.RANGE).build(),
                        )
                        .projection(Projection.builder().projectionType(ProjectionType.ALL).build())
                        .build(),
                    GlobalSecondaryIndex.builder()
                        .indexName("gsi-correlationId")
                        .keySchema(
                            KeySchemaElement.builder().attributeName("correlationId").keyType(KeyType.HASH).build(),
                            KeySchemaElement.builder().attributeName("pk").keyType(KeyType.RANGE).build(),
                        )
                        .projection(Projection.builder().projectionType(ProjectionType.ALL).build())
                        .build(),
                )
                .build(),
        )
    }

    private val table = client.table(TABLE_NAME, TableSchema.fromBean(EdrEntry::class.java))
    private val edrEntryIndex = DdbEdrEntryIndex(CriterionOperatorRegistryImpl.ofDefaults(), table)

    override fun getStore(): EndpointDataReferenceEntryIndex = edrEntryIndex
}
