// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.agreements

import org.eclipse.edc.spi.result.StoreResult
import org.eclipse.tractusx.edc.agreements.bpns.spi.store.AgreementsBpnsStore
import org.eclipse.tractusx.edc.agreements.bpns.spi.store.AgreementsBpnsStore.ALREADY_EXISTS_TEMPLATE
import org.eclipse.tractusx.edc.agreements.bpns.spi.types.AgreementsBpnsEntry
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.edc.extensions.common.ddb.EntityType
import software.amazon.edc.extensions.common.ddb.utility.keyFromPkSk
import software.amazon.edc.extensions.controlplane.ddb.types.AgreementBpns
import software.amazon.edc.extensions.controlplane.ddb.types.toDdbAgreementBpns

class DdbAgreementsBpnsStore(
    private val table: DynamoDbTable<AgreementBpns>,
) : AgreementsBpnsStore {
    override fun save(agreementsBpnsEntry: AgreementsBpnsEntry): StoreResult<Void> =
        if (table.getItem(keyFromPkSk(EntityType.AGREEMENT_BPNS, agreementsBpnsEntry.agreementId)) == null) {
            table.putItem(agreementsBpnsEntry.toDdbAgreementBpns())
            StoreResult.success()
        } else {
            StoreResult.alreadyExists(ALREADY_EXISTS_TEMPLATE.format(agreementsBpnsEntry.agreementId))
        }
}
