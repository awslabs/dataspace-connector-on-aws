// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb.utility

import java.time.Clock

/**
 * Single-entry, TTL-bounded cache of a store's state-index query result, so the repeated
 * per-state `nextNotLeased()` reads within one state-machine iteration share one query.
 *
 * Callers MUST still run the live lease check and acquisition per item, so a cache hit can
 * never process an entity twice; stores invalidate on writes (save/delete/lease change).
 */
class IterationCache<T>(
    private val ttlMillis: Long,
    private val clock: Clock = Clock.systemUTC(),
) {
    private var expiresAtMillis: Long = 0
    private var cached: List<T>? = null

    @Synchronized
    fun getOrLoad(loader: () -> List<T>): List<T> {
        val current = cached
        if (current != null && clock.millis() < expiresAtMillis) {
            return current
        }
        val loaded = loader()
        cached = loaded
        expiresAtMillis = clock.millis() + ttlMillis
        return loaded
    }

    @Synchronized
    fun invalidate() {
        cached = null
        expiresAtMillis = 0
    }
}
