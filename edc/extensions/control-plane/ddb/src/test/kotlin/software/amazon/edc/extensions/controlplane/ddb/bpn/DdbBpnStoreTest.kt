// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.bpn

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import org.eclipse.tractusx.edc.validation.businesspartner.spi.store.BusinessPartnerStore
import org.eclipse.tractusx.edc.validation.businesspartner.store.BusinessPartnerStoreTestBase
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.edc.extensions.controlplane.ddb.types.BpnGroup

class DdbBpnStoreTest : BusinessPartnerStoreTestBase() {
    private val client =
        DynamoDbEnhancedClient
            .builder()
            .dynamoDbClient(DynamoDBEmbedded.create().dynamoDbClient())
            .build()
    private val table =
        client
            .table(BpnGroup.TABLE_NAME, TableSchema.fromBean(BpnGroup::class.java))
            .apply { createTable() }

    private val bpnStore = DdbBpnStore(table)

    override fun getStore(): BusinessPartnerStore = bpnStore
}
