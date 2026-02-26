// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.ddb

import org.eclipse.edc.connector.dataplane.spi.store.AccessTokenDataStore
import org.eclipse.edc.connector.dataplane.spi.store.DataPlaneStore
import org.eclipse.edc.edr.spi.store.EndpointDataReferenceEntryIndex
import org.eclipse.edc.runtime.metamodel.annotation.Extension
import org.eclipse.edc.runtime.metamodel.annotation.Inject
import org.eclipse.edc.runtime.metamodel.annotation.Provides
import org.eclipse.edc.spi.query.CriterionOperatorRegistry
import org.eclipse.edc.spi.system.ServiceExtension
import org.eclipse.edc.spi.system.ServiceExtensionContext
import software.amazon.edc.extensions.dataplane.ddb.accesstokens.DdbAccessTokenDataStore
import software.amazon.edc.extensions.dataplane.ddb.store.DdbDataPlaneStore
import software.amazon.edc.extensions.dataplane.ddb.types.AccessToken
import software.amazon.edc.extensions.dataplane.ddb.types.DataFlow
import software.amazon.edc.extensions.common.ddb.edr.DdbEdrEntryIndex
import software.amazon.edc.extensions.common.ddb.types.EdrEntry
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import java.time.Clock

@Provides(
    AccessTokenDataStore::class,
    DataPlaneStore::class,
    EndpointDataReferenceEntryIndex::class,
)
@Extension("Data Plane DynamoDB Store Extension")
class DataPlaneDdbExtension : ServiceExtension {
    @Inject
    private lateinit var clock: Clock

    @Inject
    private lateinit var criterionOperatorRegistry: CriterionOperatorRegistry

    private lateinit var ddbClient: DynamoDbEnhancedClient
    private lateinit var leaseTable: DynamoDbTable<Lease>

    private lateinit var accessTokenDataStoreImpl: DdbAccessTokenDataStore
    private lateinit var dataPlaneStoreImpl: DataPlaneStore

    override fun initialize(context: ServiceExtensionContext) {
        val monitor = context.monitor
        monitor.info("Initializing Data Plane DynamoDB Extension!")
//        log().info("Initializing Data Plane DynamoDB Extension!")
        ddbClient = DynamoDbEnhancedClient.builder().dynamoDbClient(DynamoDbClient.create()).build()
        leaseTable = ddbClient.table(Lease.TABLE_NAME, TableSchema.fromBean(Lease::class.java))

        accessTokenDataStoreImpl = DdbAccessTokenDataStore(
            criterionOperatorRegistry,
            ddbClient.table(AccessToken.TABLE_NAME, TableSchema.fromBean(AccessToken::class.java))
        )
        context.registerService(AccessTokenDataStore::class.java, accessTokenDataStoreImpl)

        dataPlaneStoreImpl = DdbDataPlaneStore(
            clock = clock,
            leaseTable = leaseTable,
            leaseHolder = context.runtimeId,
            table = ddbClient.table(DataFlow.TABLE_NAME, TableSchema.fromBean(DataFlow::class.java))
        )
        context.registerService(DataPlaneStore::class.java, dataPlaneStoreImpl)

        val edrIndex = DdbEdrEntryIndex(
            ddbClient.table(EdrEntry.TABLE_NAME, TableSchema.fromBean(EdrEntry::class.java))
        )
        context.registerService(EndpointDataReferenceEntryIndex::class.java, edrIndex)

        monitor.info("Data Plane DynamoDB Extension initialization complete!")
//        log().info("Data Plane DynamoDB Extension initialization complete!")
    }
}
