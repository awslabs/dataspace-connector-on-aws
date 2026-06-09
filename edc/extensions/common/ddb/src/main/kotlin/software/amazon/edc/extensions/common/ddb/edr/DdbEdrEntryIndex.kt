// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb.edr

import org.eclipse.edc.edr.spi.store.EndpointDataReferenceEntryIndex
import org.eclipse.edc.edr.spi.types.EndpointDataReferenceEntry
import org.eclipse.edc.spi.query.CriterionOperatorRegistry
import org.eclipse.edc.spi.query.QuerySpec
import org.eclipse.edc.spi.result.StoreResult
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.edc.extensions.common.ddb.EntityType
import software.amazon.edc.extensions.common.ddb.types.EdrEntry
import software.amazon.edc.extensions.common.ddb.types.toDdbEdrEntry
import software.amazon.edc.extensions.common.ddb.utility.applyOffsetAndLimit
import software.amazon.edc.extensions.common.ddb.utility.getGenericPropertyComparator
import software.amazon.edc.extensions.common.ddb.utility.keyFromPkSk
import software.amazon.edc.extensions.common.ddb.utility.queryRequestFromPk
import software.amazon.edc.extensions.common.ddb.utility.toPredicate

class DdbEdrEntryIndex(
    private val criterionOperatorRegistry: CriterionOperatorRegistry,
    private val table: DynamoDbTable<EdrEntry>,
) : EndpointDataReferenceEntryIndex {
    override fun findById(id: String): EndpointDataReferenceEntry? = table.getItem(keyFromPkSk(EntityType.EDR_ENTRY, id))?.toEdcType()

    override fun query(querySpec: QuerySpec): StoreResult<MutableList<EndpointDataReferenceEntry>> {
        val predicate = querySpec.filterExpression.toPredicate<Any>(criterionOperatorRegistry)
        val result = table.query(queryRequestFromPk(EntityType.EDR_ENTRY))

        return StoreResult.success(
            result
                .flatMap { it.items() }
                .asSequence()
                .map { it.toEdcType() }
                .filter { predicate.test(it) }
                .sortedWith(querySpec.getGenericPropertyComparator())
                .applyOffsetAndLimit(querySpec)
                .toMutableList(),
        )
    }

    override fun save(entry: EndpointDataReferenceEntry): StoreResult<Void> {
        table.putItem(entry.toDdbEdrEntry())
        return StoreResult.success()
    }

    override fun delete(transferProcessId: String): StoreResult<EndpointDataReferenceEntry> {
        val key = keyFromPkSk(EntityType.EDR_ENTRY, transferProcessId)
        val result = table.deleteItem(key)
        return if (result == null) {
            StoreResult.notFound("EDR entry with transferProcessId=$transferProcessId not found!")
        } else {
            StoreResult.success(result.toEdcType())
        }
    }
}
