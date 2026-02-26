// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.bpn

import org.eclipse.edc.spi.result.StoreResult
import org.eclipse.tractusx.edc.validation.businesspartner.spi.BusinessPartnerStore
import org.eclipse.tractusx.edc.validation.businesspartner.spi.BusinessPartnerStore.ALREADY_EXISTS_TEMPLATE
import org.eclipse.tractusx.edc.validation.businesspartner.spi.BusinessPartnerStore.NOT_FOUND_TEMPLATE
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.edc.extensions.common.ddb.utility.keyFromId
import software.amazon.edc.extensions.controlplane.ddb.types.BpnGroup

class DdbBpnStore(
    private val table: DynamoDbTable<BpnGroup>,
) : BusinessPartnerStore {
    override fun resolveForBpn(bpn: String): StoreResult<MutableList<String>> =
        getBpnGroup(bpn)?.groups?.let { StoreResult.success(it.toMutableList()) }
            ?: StoreResult.notFound(NOT_FOUND_TEMPLATE.format(bpn))

    override fun save(
        bpn: String,
        groups: List<String>?,
    ): StoreResult<Void> {
        return if (getBpnGroup(bpn) == null) {
            val bpnGroup =
                BpnGroup(
                    bpn = bpn,
                    groups = groups,
                )
            table.putItem(bpnGroup)
            StoreResult.success()
        } else {
            StoreResult.alreadyExists(ALREADY_EXISTS_TEMPLATE.format(bpn))
        }
    }

    override fun delete(bpn: String): StoreResult<Void> {
        val bpnGroup = getBpnGroup(bpn) ?: return StoreResult.notFound(NOT_FOUND_TEMPLATE.format(bpn))
        table.deleteItem(bpnGroup)
        return StoreResult.success()
    }

    override fun update(
        bpn: String,
        groups: List<String>?,
    ): StoreResult<Void> {
        val bpnGroup = getBpnGroup(bpn) ?: return StoreResult.notFound(NOT_FOUND_TEMPLATE.format(bpn))
        bpnGroup.groups = groups
        table.updateItem(bpnGroup)
        return StoreResult.success()
    }

    private fun getBpnGroup(bpn: String): BpnGroup? = table.getItem(keyFromId(bpn))
}
