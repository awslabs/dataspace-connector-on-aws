// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb.edr

import org.eclipse.edc.edr.spi.store.EndpointDataReferenceEntryIndex
import org.eclipse.edc.edr.spi.types.EndpointDataReferenceEntry
import org.eclipse.edc.spi.query.QuerySpec
import org.eclipse.edc.spi.result.StoreResult
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.edc.extensions.common.ddb.types.EdrEntry
import software.amazon.edc.extensions.common.ddb.types.toDdbEdrEntry
import software.amazon.edc.extensions.common.ddb.utility.applyOffsetAndLimit
import software.amazon.edc.extensions.common.ddb.utility.getGenericPropertyComparator
import software.amazon.edc.extensions.common.ddb.utility.keyFromId
import software.amazon.edc.extensions.common.ddb.utility.toScanRequest

class DdbEdrEntryIndex(private val table: DynamoDbTable<EdrEntry>) : EndpointDataReferenceEntryIndex {
    override fun findById(id: String): EndpointDataReferenceEntry? = table.getItem(keyFromId(id))?.toEdcType()

    override fun query(querySpec: QuerySpec): StoreResult<MutableList<EndpointDataReferenceEntry>> {
        val scanRequest = querySpec.toScanRequest(mapOf("transferProcessId" to "id"))
        val result = table.scan(scanRequest)

        return StoreResult.success(
            result.items().asSequence().map { it.toEdcType() }
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
        val result = table.deleteItem(Key.builder().partitionValue(transferProcessId).build())
        return if (result == null) {
            StoreResult.notFound("EDR entry with transferProcessId=$transferProcessId not found!")
        } else {
            StoreResult.success(result.toEdcType())
        }
    }
}
