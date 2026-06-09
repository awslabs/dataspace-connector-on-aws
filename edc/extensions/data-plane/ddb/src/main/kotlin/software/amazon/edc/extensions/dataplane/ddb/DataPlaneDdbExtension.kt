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
import org.eclipse.edc.spi.types.TypeManager
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.edc.extensions.common.ddb.EDC_DDB_TABLE_NAME_SETTING
import software.amazon.edc.extensions.common.ddb.edr.DdbEdrEntryIndex
import software.amazon.edc.extensions.common.ddb.types.EdrEntry
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.dataplane.ddb.accesstokens.DdbAccessTokenDataStore
import software.amazon.edc.extensions.dataplane.ddb.store.DdbDataPlaneStore
import software.amazon.edc.extensions.dataplane.ddb.types.AccessToken
import software.amazon.edc.extensions.dataplane.ddb.types.DataFlow
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

    @Inject
    private lateinit var typeManager: TypeManager

    override fun initialize(context: ServiceExtensionContext) {
        val tableName = context.getSetting(EDC_DDB_TABLE_NAME_SETTING, "")
        require(tableName.isNotBlank()) { "Setting '$EDC_DDB_TABLE_NAME_SETTING' must be configured!" }

        val monitor = context.monitor
        monitor.info("Initializing Data Plane DynamoDB Extension with table: $tableName")

        val ddbClient = DynamoDbEnhancedClient.builder().dynamoDbClient(DynamoDbClient.create()).build()

        val leaseTable = ddbClient.table(tableName, TableSchema.fromBean(Lease::class.java))
        val accessTokenTable = ddbClient.table(tableName, TableSchema.fromBean(AccessToken::class.java))
        val dataFlowTable = ddbClient.table(tableName, TableSchema.fromBean(DataFlow::class.java))
        val edrEntryTable = ddbClient.table(tableName, TableSchema.fromBean(EdrEntry::class.java))

        context.registerService(
            AccessTokenDataStore::class.java,
            DdbAccessTokenDataStore(
                criterionOperatorRegistry,
                accessTokenTable,
                context.getSetting("edc.dataplane.token.expiry.seconds", 300).toLong(),
            ),
        )

        context.registerService(
            DataPlaneStore::class.java,
            DdbDataPlaneStore(
                clock = clock,
                criterionOperatorRegistry = criterionOperatorRegistry,
                leaseTable = leaseTable,
                leaseHolder = context.runtimeId,
                objectMapper = typeManager.mapper,
                table = dataFlowTable,
            ),
        )

        context.registerService(
            EndpointDataReferenceEntryIndex::class.java,
            DdbEdrEntryIndex(criterionOperatorRegistry, edrEntryTable),
        )

        monitor.info("Data Plane DynamoDB Extension initialization complete!")
    }
}
