// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.agreements

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import org.eclipse.edc.query.CriterionOperatorRegistryImpl
import org.eclipse.tractusx.edc.agreements.retirement.spi.store.AgreementsRetirementStore
import org.eclipse.tractusx.edc.agreements.retirement.store.AgreementsRetirementStoreTestBase
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.controlplane.ddb.TestTableHelper
import software.amazon.edc.extensions.controlplane.ddb.types.AgreementRetirement

class DdbAgreementsRetirementStoreTest : AgreementsRetirementStoreTestBase() {
    private val ddbClient = DynamoDBEmbedded.create().dynamoDbClient()
    private val client = DynamoDbEnhancedClient.builder().dynamoDbClient(ddbClient).build()

    init {
        ddbClient.createTable(TestTableHelper.createRequest())
    }

    private val store =
        DdbAgreementsRetirementStore(
            CriterionOperatorRegistryImpl.ofDefaults(),
            client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(AgreementRetirement::class.java)),
        )

    override fun getStore(): AgreementsRetirementStore = store
}
