// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb

import org.eclipse.edc.connector.controlplane.asset.spi.index.AssetIndex
import org.eclipse.edc.connector.controlplane.asset.spi.index.DataAddressResolver
import org.eclipse.edc.connector.controlplane.contract.spi.negotiation.store.ContractNegotiationStore
import org.eclipse.edc.connector.controlplane.contract.spi.offer.store.ContractDefinitionStore
import org.eclipse.edc.connector.controlplane.policy.spi.store.PolicyDefinitionStore
import org.eclipse.edc.connector.controlplane.query.asset.AssetPropertyLookup
import org.eclipse.edc.connector.controlplane.transfer.spi.store.TransferProcessStore
import org.eclipse.edc.connector.dataplane.selector.spi.store.DataPlaneInstanceStore
import org.eclipse.edc.connector.policy.monitor.spi.PolicyMonitorStore
import org.eclipse.edc.edr.spi.store.EndpointDataReferenceEntryIndex
import org.eclipse.edc.runtime.metamodel.annotation.Extension
import org.eclipse.edc.runtime.metamodel.annotation.Inject
import org.eclipse.edc.runtime.metamodel.annotation.Provides
import org.eclipse.edc.spi.query.CriterionOperatorRegistry
import org.eclipse.edc.spi.system.ServiceExtension
import org.eclipse.edc.spi.system.ServiceExtensionContext
import org.eclipse.edc.spi.types.TypeManager
import org.eclipse.tractusx.edc.validation.businesspartner.spi.store.BusinessPartnerStore
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.edc.extensions.common.ddb.EDC_DDB_TABLE_NAME_SETTING
import software.amazon.edc.extensions.common.ddb.edr.DdbEdrEntryIndex
import software.amazon.edc.extensions.common.ddb.types.EdrEntry
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.controlplane.ddb.assets.DdbAssetIndex
import software.amazon.edc.extensions.controlplane.ddb.bpn.DdbBpnStore
import software.amazon.edc.extensions.controlplane.ddb.contracts.DdbContractDefinitionStore
import software.amazon.edc.extensions.controlplane.ddb.contracts.DdbContractNegotiationStore
import software.amazon.edc.extensions.controlplane.ddb.dataplane.DdbDataPlaneInstanceStore
import software.amazon.edc.extensions.controlplane.ddb.policies.DdbPolicyDefinitionStore
import software.amazon.edc.extensions.controlplane.ddb.policies.DdbPolicyMonitorStore
import software.amazon.edc.extensions.controlplane.ddb.transfers.DdbTransferProcessStore
import software.amazon.edc.extensions.controlplane.ddb.types.Asset
import software.amazon.edc.extensions.controlplane.ddb.types.BpnGroup
import software.amazon.edc.extensions.controlplane.ddb.types.ContractAgreement
import software.amazon.edc.extensions.controlplane.ddb.types.ContractDefinition
import software.amazon.edc.extensions.controlplane.ddb.types.ContractNegotiation
import software.amazon.edc.extensions.controlplane.ddb.types.DataPlaneInstance
import software.amazon.edc.extensions.controlplane.ddb.types.PolicyDefinition
import software.amazon.edc.extensions.controlplane.ddb.types.PolicyMonitor
import software.amazon.edc.extensions.controlplane.ddb.types.TransferProcess
import java.time.Clock

@Extension("Control Plane DynamoDB Store Extension")
@Provides(
    AssetIndex::class,
    BusinessPartnerStore::class,
    ContractDefinitionStore::class,
    ContractNegotiationStore::class,
    DataAddressResolver::class,
    DataPlaneInstanceStore::class,
    EndpointDataReferenceEntryIndex::class,
    PolicyDefinitionStore::class,
    PolicyMonitorStore::class,
    TransferProcessStore::class,
)
class ControlPlaneDdbExtension : ServiceExtension {
    @Inject
    private lateinit var clock: Clock

    @Inject
    private lateinit var criterionOperatorRegistry: CriterionOperatorRegistry

    @Inject
    private lateinit var typeManager: TypeManager

    override fun initialize(context: ServiceExtensionContext) {
        val tableName = context.getSetting(EDC_DDB_TABLE_NAME_SETTING, "")
        require(tableName.isNotBlank()) { "Setting '$EDC_DDB_TABLE_NAME_SETTING' must be configured!" }

        val ddbClient = DynamoDbEnhancedClient.builder().dynamoDbClient(DynamoDbClient.create()).build()

        criterionOperatorRegistry.registerPropertyLookup(AssetPropertyLookup())

        val leaseTable = ddbClient.table(tableName, TableSchema.fromBean(Lease::class.java))
        val assetTable = ddbClient.table(tableName, TableSchema.fromBean(Asset::class.java))
        val bpnTable = ddbClient.table(tableName, TableSchema.fromBean(BpnGroup::class.java))
        val contractAgreementTable = ddbClient.table(tableName, TableSchema.fromBean(ContractAgreement::class.java))
        val contractDefinitionTable = ddbClient.table(tableName, TableSchema.fromBean(ContractDefinition::class.java))
        val contractNegotiationTable = ddbClient.table(tableName, TableSchema.fromBean(ContractNegotiation::class.java))
        val dataPlaneInstanceTable = ddbClient.table(tableName, TableSchema.fromBean(DataPlaneInstance::class.java))
        val edrEntryTable = ddbClient.table(tableName, TableSchema.fromBean(EdrEntry::class.java))
        val policyDefinitionTable = ddbClient.table(tableName, TableSchema.fromBean(PolicyDefinition::class.java))
        val policyMonitorTable = ddbClient.table(tableName, TableSchema.fromBean(PolicyMonitor::class.java))
        val transferProcessTable = ddbClient.table(tableName, TableSchema.fromBean(TransferProcess::class.java))

        val assetIndex = DdbAssetIndex(criterionOperatorRegistry, assetTable)
        context.registerService(AssetIndex::class.java, assetIndex)
        context.registerService(DataAddressResolver::class.java, assetIndex)

        context.registerService(
            BusinessPartnerStore::class.java,
            DdbBpnStore(bpnTable),
        )

        context.registerService(
            ContractDefinitionStore::class.java,
            DdbContractDefinitionStore(criterionOperatorRegistry, typeManager.mapper, contractDefinitionTable),
        )

        context.registerService(
            ContractNegotiationStore::class.java,
            DdbContractNegotiationStore(
                clock = clock,
                criterionOperatorRegistry = criterionOperatorRegistry,
                leaseHolder = context.runtimeId,
                leaseTable = leaseTable,
                contractAgreementTable = contractAgreementTable,
                contractNegotiationTable = contractNegotiationTable,
                objectMapper = typeManager.mapper,
            ),
        )

        context.registerService(
            DataPlaneInstanceStore::class.java,
            DdbDataPlaneInstanceStore(
                clock = clock,
                leaseHolder = context.runtimeId,
                leaseTable = leaseTable,
                table = dataPlaneInstanceTable,
            ),
        )

        context.registerService(
            EndpointDataReferenceEntryIndex::class.java,
            DdbEdrEntryIndex(criterionOperatorRegistry, edrEntryTable),
        )

        context.registerService(
            PolicyDefinitionStore::class.java,
            DdbPolicyDefinitionStore(criterionOperatorRegistry, typeManager.mapper, policyDefinitionTable),
        )

        context.registerService(
            PolicyMonitorStore::class.java,
            DdbPolicyMonitorStore(
                clock = clock,
                leaseHolder = context.runtimeId,
                leaseTable = leaseTable,
                table = policyMonitorTable,
            ),
        )

        context.registerService(
            TransferProcessStore::class.java,
            DdbTransferProcessStore(
                clock = clock,
                leaseHolder = context.runtimeId,
                leaseTable = leaseTable,
                criterionOperatorRegistry = criterionOperatorRegistry,
                objectMapper = typeManager.mapper,
                table = transferProcessTable,
            ),
        )
    }
}
