// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.agreements

import org.eclipse.edc.spi.query.CriterionOperatorRegistry
import org.eclipse.edc.spi.query.QuerySpec
import org.eclipse.edc.spi.result.StoreResult
import org.eclipse.edc.store.ReflectionBasedQueryResolver
import org.eclipse.tractusx.edc.agreements.retirement.spi.store.AgreementsRetirementStore
import org.eclipse.tractusx.edc.agreements.retirement.spi.store.AgreementsRetirementStore.ALREADY_EXISTS_TEMPLATE
import org.eclipse.tractusx.edc.agreements.retirement.spi.store.AgreementsRetirementStore.NOT_FOUND_IN_RETIREMENT_TEMPLATE
import org.eclipse.tractusx.edc.agreements.retirement.spi.types.AgreementsRetirementEntry
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.edc.extensions.common.ddb.EntityType
import software.amazon.edc.extensions.common.ddb.utility.keyFromPkSk
import software.amazon.edc.extensions.common.ddb.utility.queryRequestFromPk
import software.amazon.edc.extensions.controlplane.ddb.types.AgreementRetirement
import software.amazon.edc.extensions.controlplane.ddb.types.toDdbAgreementRetirement
import java.util.stream.Stream

class DdbAgreementsRetirementStore(
    criterionOperatorRegistry: CriterionOperatorRegistry,
    private val table: DynamoDbTable<AgreementRetirement>,
) : AgreementsRetirementStore {
    private val queryResolver = ReflectionBasedQueryResolver(AgreementsRetirementEntry::class.java, criterionOperatorRegistry)

    override fun save(entry: AgreementsRetirementEntry): StoreResult<Void> =
        if (get(entry.agreementId) == null) {
            table.putItem(entry.toDdbAgreementRetirement())
            StoreResult.success()
        } else {
            StoreResult.alreadyExists(ALREADY_EXISTS_TEMPLATE.format(entry.agreementId))
        }

    override fun delete(contractAgreementId: String): StoreResult<Void> {
        val item = get(contractAgreementId) ?: return StoreResult.notFound(NOT_FOUND_IN_RETIREMENT_TEMPLATE.format(contractAgreementId))
        table.deleteItem(item)
        return StoreResult.success()
    }

    override fun findRetiredAgreements(querySpec: QuerySpec): Stream<AgreementsRetirementEntry> =
        queryResolver.query(
            table
                .query(queryRequestFromPk(EntityType.AGREEMENT_RETIREMENT))
                .items()
                .stream()
                .map { it.toEdcEntry() },
            querySpec,
        )

    private fun get(agreementId: String): AgreementRetirement? = table.getItem(keyFromPkSk(EntityType.AGREEMENT_RETIREMENT, agreementId))
}
