// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.types

import org.eclipse.edc.connector.policy.monitor.spi.PolicyMonitorEntry
import org.eclipse.edc.connector.policy.monitor.spi.PolicyMonitorEntryStates
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import software.amazon.edc.extensions.common.ddb.EntityType

/**
 * Fix 4: only STARTED policy monitors belong in the state index. Terminal (COMPLETED/FAILED) entries
 * must be de-indexed (gsiStatePk = null) so they are neither re-processed nor scanned by nextNotLeased.
 */
class PolicyMonitorDeindexTest {
    private fun entry(state: Int): PolicyMonitorEntry =
        PolicyMonitorEntry.Builder
            .newInstance()
            .id("pm-1")
            .state(state)
            .build()

    @Test
    fun `started monitor is indexed`() {
        assertEquals(
            EntityType.POLICY_MONITOR,
            entry(PolicyMonitorEntryStates.STARTED.code()).toDdbPolicyMonitor().gsiStatePk,
        )
    }

    @Test
    fun `terminal monitors are de-indexed`() {
        assertNull(entry(PolicyMonitorEntryStates.COMPLETED.code()).toDdbPolicyMonitor().gsiStatePk)
        assertNull(entry(PolicyMonitorEntryStates.FAILED.code()).toDdbPolicyMonitor().gsiStatePk)
    }
}
