// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb.edr

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import org.eclipse.edc.edr.spi.store.EndpointDataReferenceEntryIndex
import org.eclipse.edc.edr.spi.store.EndpointDataReferenceEntryIndexTestBase
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.common.ddb.types.EdrEntry

class DdbEdrEntryIndexTest : EndpointDataReferenceEntryIndexTestBase() {
    private val client =
        DynamoDbEnhancedClient
            .builder()
            .dynamoDbClient(DynamoDBEmbedded.create().dynamoDbClient())
            .build()
    private val table =
        client.table(EdrEntry.TABLE_NAME, TableSchema.fromBean(EdrEntry::class.java)).also {
            it.createTable()
        }
    private val edrEntryIndex: DdbEdrEntryIndex = DdbEdrEntryIndex(table)

    override fun getStore(): EndpointDataReferenceEntryIndex = edrEntryIndex
}
