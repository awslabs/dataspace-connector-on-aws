// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.agreements

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import org.eclipse.tractusx.edc.agreements.bpns.spi.store.AgreementsBpnsStore
import org.eclipse.tractusx.edc.agreements.bpns.store.AgreementsBpnsStoreTestBase
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.controlplane.ddb.TestTableHelper
import software.amazon.edc.extensions.controlplane.ddb.types.AgreementBpns

class DdbAgreementsBpnsStoreTest : AgreementsBpnsStoreTestBase() {
    private val ddbClient = DynamoDBEmbedded.create().dynamoDbClient()
    private val client = DynamoDbEnhancedClient.builder().dynamoDbClient(ddbClient).build()

    init {
        ddbClient.createTable(TestTableHelper.createRequest())
    }

    private val store = DdbAgreementsBpnsStore(client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(AgreementBpns::class.java)))

    override fun getStore(): AgreementsBpnsStore = store
}
