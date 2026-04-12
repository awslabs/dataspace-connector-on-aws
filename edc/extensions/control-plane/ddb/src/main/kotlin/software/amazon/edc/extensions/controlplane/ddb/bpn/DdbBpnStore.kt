// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.bpn

import org.eclipse.edc.spi.result.StoreResult
import org.eclipse.tractusx.edc.validation.businesspartner.spi.store.BusinessPartnerStore
import org.eclipse.tractusx.edc.validation.businesspartner.spi.store.BusinessPartnerStore.ALREADY_EXISTS_TEMPLATE
import org.eclipse.tractusx.edc.validation.businesspartner.spi.store.BusinessPartnerStore.NOT_FOUND_TEMPLATE
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.edc.extensions.common.ddb.utility.keyFromId
import software.amazon.edc.extensions.controlplane.ddb.types.BpnGroup

class DdbBpnStore(
    private val table: DynamoDbTable<BpnGroup>,
) : BusinessPartnerStore {
    override fun resolveForBpn(businessPartnerNumber: String): StoreResult<List<String>> =
        getBpnGroup(businessPartnerNumber)?.groups?.let { StoreResult.success(it.toList()) }
            ?: StoreResult.notFound(NOT_FOUND_TEMPLATE.format(businessPartnerNumber))

    override fun resolveForBpnGroup(businessPartnerGroup: String): StoreResult<List<String>> {
        val allBpns =
            table.scan().items()
                .filter { it.groups?.contains(businessPartnerGroup) == true }
                .map { it.bpn }
        return StoreResult.success(allBpns)
    }

    override fun resolveForBpnGroups(): StoreResult<List<String>> {
        val allGroups =
            table.scan().items()
                .flatMap { it.groups ?: emptyList() }
                .distinct()
        return StoreResult.success(allGroups)
    }

    override fun save(
        businessPartnerNumber: String,
        groups: List<String>?,
    ): StoreResult<Void> {
        return if (getBpnGroup(businessPartnerNumber) == null) {
            val bpnGroup =
                BpnGroup(
                    bpn = businessPartnerNumber,
                    groups = groups,
                )
            table.putItem(bpnGroup)
            StoreResult.success()
        } else {
            StoreResult.alreadyExists(ALREADY_EXISTS_TEMPLATE.format(businessPartnerNumber))
        }
    }

    override fun delete(businessPartnerNumber: String): StoreResult<Void> {
        val bpnGroup = getBpnGroup(businessPartnerNumber) ?: return StoreResult.notFound(NOT_FOUND_TEMPLATE.format(businessPartnerNumber))
        table.deleteItem(bpnGroup)
        return StoreResult.success()
    }

    override fun update(
        businessPartnerNumber: String,
        groups: List<String>?,
    ): StoreResult<Void> {
        val bpnGroup = getBpnGroup(businessPartnerNumber) ?: return StoreResult.notFound(NOT_FOUND_TEMPLATE.format(businessPartnerNumber))
        bpnGroup.groups = groups
        table.updateItem(bpnGroup)
        return StoreResult.success()
    }

    private fun getBpnGroup(bpn: String): BpnGroup? = table.getItem(keyFromId(bpn))
}
