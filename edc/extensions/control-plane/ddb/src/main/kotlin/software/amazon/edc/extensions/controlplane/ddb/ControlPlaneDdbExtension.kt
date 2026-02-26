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
import org.eclipse.tractusx.edc.validation.businesspartner.spi.BusinessPartnerStore
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
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
    private val ddbClient = DynamoDbEnhancedClient.builder().dynamoDbClient(DynamoDbClient.create()).build()
    private val leaseTable: DynamoDbTable<Lease> =
        ddbClient.table(Lease.TABLE_NAME, TableSchema.fromBean(Lease::class.java))

    @Inject
    private lateinit var clock: Clock

    @Inject
    private lateinit var criterionOperatorRegistry: CriterionOperatorRegistry

    @Inject
    private lateinit var typeManager: TypeManager

    private lateinit var assetIndexImpl: DdbAssetIndex
    private lateinit var bpnStoreImpl: DdbBpnStore
    private lateinit var contractDefinitionStoreImpl: DdbContractDefinitionStore
    private lateinit var contractNegotiationStoreImpl: DdbContractNegotiationStore
    private lateinit var dataPlaneInstanceStoreImpl: DdbDataPlaneInstanceStore
    private lateinit var edrIndexImpl: DdbEdrEntryIndex
    private lateinit var policyDefinitionStoreImpl: DdbPolicyDefinitionStore
    private lateinit var policyMonitorStoreImpl: DdbPolicyMonitorStore
    private lateinit var transferProcessStoreImpl: DdbTransferProcessStore

    override fun initialize(context: ServiceExtensionContext) {
//        log().info("Initializing....")
        criterionOperatorRegistry.registerPropertyLookup(AssetPropertyLookup())

        assetIndexImpl =
            DdbAssetIndex(
                criterionOperatorRegistry,
                ddbClient.table(Asset.TABLE_NAME, TableSchema.fromBean(Asset::class.java)),
            )
        context.registerService(AssetIndex::class.java, assetIndexImpl)
        context.registerService(DataAddressResolver::class.java, assetIndexImpl)

        bpnStoreImpl = DdbBpnStore(ddbClient.table(BpnGroup.TABLE_NAME, TableSchema.fromBean(BpnGroup::class.java)))
        context.registerService(BusinessPartnerStore::class.java, bpnStoreImpl)

        contractDefinitionStoreImpl =
            DdbContractDefinitionStore(
                criterionOperatorRegistry = criterionOperatorRegistry,
                objectMapper = typeManager.mapper,
                table =
                    ddbClient.table(
                        ContractDefinition.TABLE_NAME,
                        TableSchema.fromBean(ContractDefinition::class.java),
                    ),
            )
        context.registerService(ContractDefinitionStore::class.java, contractDefinitionStoreImpl)

        contractNegotiationStoreImpl =
            DdbContractNegotiationStore(
                criterionOperatorRegistry = criterionOperatorRegistry,
                objectMapper = typeManager.mapper,
                clock = clock,
                leaseHolder = context.runtimeId,
                leaseTable = leaseTable,
                contractAgreementTable =
                    ddbClient.table(
                        ContractAgreement.TABLE_NAME,
                        TableSchema.fromBean(ContractAgreement::class.java),
                    ),
                contractNegotiationTable =
                    ddbClient.table(
                        ContractNegotiation.TABLE_NAME,
                        TableSchema.fromBean(ContractNegotiation::class.java),
                    ),
            )
        context.registerService(ContractNegotiationStore::class.java, contractNegotiationStoreImpl)

        dataPlaneInstanceStoreImpl =
            DdbDataPlaneInstanceStore(
                clock = clock,
                leaseHolder = context.runtimeId,
                leaseTable = leaseTable,
                table =
                    ddbClient.table(
                        DataPlaneInstance.TABLE_NAME,
                        TableSchema.fromBean(DataPlaneInstance::class.java),
                    ),
            )
        context.registerService(DataPlaneInstanceStore::class.java, dataPlaneInstanceStoreImpl)

        edrIndexImpl =
            DdbEdrEntryIndex(
                ddbClient.table(EdrEntry.TABLE_NAME, TableSchema.fromBean(EdrEntry::class.java)),
            )
        context.registerService(EndpointDataReferenceEntryIndex::class.java, edrIndexImpl)

        policyDefinitionStoreImpl =
            DdbPolicyDefinitionStore(
                criterionOperatorRegistry = criterionOperatorRegistry,
                objectMapper = typeManager.mapper,
                table = ddbClient.table(PolicyDefinition.TABLE_NAME, TableSchema.fromBean(PolicyDefinition::class.java)),
            )
        context.registerService(PolicyDefinitionStore::class.java, policyDefinitionStoreImpl)

        policyMonitorStoreImpl =
            DdbPolicyMonitorStore(
                clock = clock,
                leaseHolder = context.runtimeId,
                leaseTable = leaseTable,
                table = ddbClient.table(PolicyMonitor.TABLE_NAME, TableSchema.fromBean(PolicyMonitor::class.java)),
            )
        context.registerService(PolicyMonitorStore::class.java, policyMonitorStoreImpl)

        transferProcessStoreImpl =
            DdbTransferProcessStore(
                clock = clock,
                leaseHolder = context.runtimeId,
                leaseTable = leaseTable,
                criterionOperatorRegistry = criterionOperatorRegistry,
                objectMapper = typeManager.mapper,
                table = ddbClient.table(TransferProcess.TABLE_NAME, TableSchema.fromBean(TransferProcess::class.java)),
            )
        context.registerService(TransferProcessStore::class.java, transferProcessStoreImpl)

//        log().info("Initialization complete!")
    }
}
