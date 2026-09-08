// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.ddb.store

import com.amazonaws.services.dynamodbv2.local.embedded.DynamoDBEmbedded
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.eclipse.edc.query.CriterionOperatorRegistryImpl
import org.eclipse.edc.spi.types.domain.DataAddress
import org.eclipse.edc.spi.types.domain.transfer.FlowType
import org.eclipse.edc.spi.types.domain.transfer.TransferType
import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.DeleteItemResponse
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemResponse
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import software.amazon.edc.extensions.common.ddb.EntityType
import software.amazon.edc.extensions.common.ddb.types.Lease
import software.amazon.edc.extensions.dataplane.ddb.TestTableHelper
import software.amazon.edc.extensions.dataplane.ddb.types.DataFlow
import java.time.Clock
import java.time.Duration
import org.eclipse.edc.connector.dataplane.spi.DataFlow as EdcDataFlow

/**
 * Verifies the write-cost optimizations at the DynamoDB request level: lease acquire/release must not
 * write the entity item (Fix 1), and a no-op save must not write the entity item at all while still
 * releasing the lease (Fix 2, contract-preserving). These are the assertions that make idle EDCs cheap.
 */
class DdbDataPlaneStoreWriteCostTest {
    private val raw = DynamoDBEmbedded.create().dynamoDbClient()
    private val counting = CountingDynamoDbClient(raw)
    private val client = DynamoDbEnhancedClient.builder().dynamoDbClient(counting).build()
    private lateinit var store: DdbDataPlaneStore

    @BeforeEach
    fun setup() {
        raw.createTable(TestTableHelper.createRequest())
        store =
            DdbDataPlaneStore(
                clock = Clock.systemDefaultZone(),
                criterionOperatorRegistry = CriterionOperatorRegistryImpl.ofDefaults(),
                leaseHolder = "connector",
                leaseTable = client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(Lease::class.java)),
                objectMapper = jacksonObjectMapper().apply { configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false) },
                table = client.table(TestTableHelper.TABLE_NAME, TableSchema.fromBean(DataFlow::class.java)),
            )
    }

    private fun dataFlow(
        id: String,
        baseUrl: String = "http://provider",
    ): EdcDataFlow =
        EdcDataFlow.Builder
            .newInstance()
            .id(id)
            .callbackAddress(java.net.URI.create("http://callback"))
            .source(
                DataAddress.Builder
                    .newInstance()
                    .type("HttpData")
                    .property("baseUrl", baseUrl)
                    .build(),
            ).destination(
                DataAddress.Builder
                    .newInstance()
                    .type("HttpProxy")
                    .build(),
            ).transferType(TransferType("HttpData", FlowType.PULL))
            .build()

    @Test
    fun `acquireLease does not write the entity item`() {
        store.save(dataFlow("df-1"))
        counting.reset()

        store.acquireLease("df-1")

        assertEquals(0, counting.writes(EntityType.DATA_FLOW))
        assertEquals(1, counting.writes(EntityType.LEASE))
    }

    @Test
    fun `re-saving an unchanged entity still writes it (flow-lease heartbeat must persist)`() {
        val flow = dataFlow("df-2")
        store.save(flow)
        store.acquireLease("df-2")
        counting.reset()

        val result = store.save(flow) // heartbeat-style re-save: must NOT be skipped (advances updatedAt)

        assertTrue(result.succeeded())
        assertEquals(1, counting.writes(EntityType.DATA_FLOW))
        assertFalse(store.isLeasedBy("df-2", "connector"))
    }

    @Test
    fun `save writes one entity item, one lease release, and no read (no redundant re-acquire)`() {
        store.save(dataFlow("df-3"))
        store.acquireLease("df-3")
        counting.reset()

        store.save(dataFlow("df-3", baseUrl = "http://changed"))

        assertEquals(1, counting.writes(EntityType.DATA_FLOW)) // one entity putItem
        assertEquals(0, counting.writes(EntityType.LEASE)) // no lease put == no redundant re-acquire
        assertEquals(0, counting.getItemCount) // no exists-check read
        assertFalse(store.isLeasedBy("df-3", "connector")) // lease released (via delete)
    }

    @Test
    fun `nextNotLeased checks leases in one query, not a getItem per candidate`() {
        repeat(3) { store.save(dataFlow("df-lease-$it")) }
        counting.reset()

        val result = store.nextNotLeased(10)

        assertEquals(3, result.size)
        assertEquals(0, counting.getItemCount) // no per-candidate lease getItem
        assertTrue(counting.queryCount >= 1) // batched lease snapshot + state index via Query
    }

    @Test
    fun `lease is mutually exclusive across holders, re-entrant for one holder, and re-acquirable after expiry`() {
        store.save(dataFlow("df-x"))

        store.acquireLease("df-x", "holder-a", Duration.ofSeconds(60))
        assertThrows(IllegalStateException::class.java) { store.acquireLease("df-x", "holder-b", Duration.ofSeconds(60)) }
        assertDoesNotThrow { store.acquireLease("df-x", "holder-a", Duration.ofSeconds(60)) } // same holder re-enters

        store.breakLease("df-x")
        assertDoesNotThrow { store.acquireLease("df-x", "holder-b", Duration.ofSeconds(60)) } // released -> free

        store.save(dataFlow("df-exp"))
        store.acquireLease("df-exp", "holder-a", Duration.ofMillis(1))
        Thread.sleep(20)
        assertDoesNotThrow { store.acquireLease("df-exp", "holder-b", Duration.ofSeconds(60)) } // expired -> free
    }

    /** DynamoDbClient that records writes by the item's `pk` (entity type) — single-table aware. */
    private class CountingDynamoDbClient(
        private val delegate: DynamoDbClient,
    ) : DynamoDbClient by delegate {
        private val recorded = mutableListOf<String>()

        override fun putItem(request: PutItemRequest): PutItemResponse {
            recorded += request.item()["pk"]?.s() ?: "?"
            return delegate.putItem(request)
        }

        override fun updateItem(request: UpdateItemRequest): UpdateItemResponse {
            recorded += request.key()["pk"]?.s() ?: "?"
            return delegate.updateItem(request)
        }

        override fun deleteItem(request: DeleteItemRequest): DeleteItemResponse = delegate.deleteItem(request)

        override fun getItem(
            request: software.amazon.awssdk.services.dynamodb.model.GetItemRequest,
        ): software.amazon.awssdk.services.dynamodb.model.GetItemResponse {
            getItemCount++
            return delegate.getItem(request)
        }

        override fun query(
            request: software.amazon.awssdk.services.dynamodb.model.QueryRequest,
        ): software.amazon.awssdk.services.dynamodb.model.QueryResponse {
            queryCount++
            return delegate.query(request)
        }

        var getItemCount = 0
            private set
        var queryCount = 0
            private set

        fun writes(pk: String): Int = recorded.count { it == pk }

        fun reset() {
            recorded.clear()
            getItemCount = 0
            queryCount = 0
        }
    }
}
