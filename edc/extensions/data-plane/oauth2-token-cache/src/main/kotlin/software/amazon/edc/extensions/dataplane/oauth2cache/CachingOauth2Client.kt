// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.oauth2cache

import org.eclipse.edc.iam.oauth2.spi.client.Oauth2Client
import org.eclipse.edc.iam.oauth2.spi.client.Oauth2CredentialsRequest
import org.eclipse.edc.iam.oauth2.spi.client.SharedSecretOauth2CredentialsRequest
import org.eclipse.edc.spi.iam.TokenRepresentation
import org.eclipse.edc.spi.result.Result
import java.time.Clock
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * Reuses a client-credentials token for identical requests (token URL and
 * form parameters) until [REFRESH_MARGIN_SECONDS] before it expires. Private
 * key JWT requests carry a unique assertion and tokens without expires_in
 * cannot be timed out, so both always go to the delegate.
 */
class CachingOauth2Client(
    private val delegate: Oauth2Client,
    private val clock: Clock,
) : Oauth2Client {
    private data class Key(
        val url: String,
        val params: Map<String, Any>,
    )

    private class Entry(
        val token: TokenRepresentation,
        val refreshAt: Instant,
    )

    private val cache = ConcurrentHashMap<Key, Entry>()

    override fun requestToken(request: Oauth2CredentialsRequest): Result<TokenRepresentation> {
        if (request !is SharedSecretOauth2CredentialsRequest) {
            return delegate.requestToken(request)
        }
        val key = Key(request.url, request.params.toMap())
        val now = clock.instant()
        cache[key]?.takeIf { now.isBefore(it.refreshAt) }?.let { return Result.success(it.token) }

        val result = delegate.requestToken(request)
        val expiresIn = result.takeIf { it.succeeded() }?.content?.expiresIn
        if (expiresIn != null && expiresIn > REFRESH_MARGIN_SECONDS) {
            cache.entries.removeIf { !now.isBefore(it.value.refreshAt) }
            cache[key] = Entry(result.content, now.plusSeconds(expiresIn - REFRESH_MARGIN_SECONDS))
        }
        return result
    }

    companion object {
        const val REFRESH_MARGIN_SECONDS = 60L
    }
}
