// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.oauth2cache

import org.eclipse.edc.iam.oauth2.spi.client.Oauth2Client
import org.eclipse.edc.iam.oauth2.spi.client.Oauth2CredentialsRequest
import org.eclipse.edc.iam.oauth2.spi.client.PrivateKeyOauth2CredentialsRequest
import org.eclipse.edc.iam.oauth2.spi.client.SharedSecretOauth2CredentialsRequest
import org.eclipse.edc.spi.iam.TokenRepresentation
import org.eclipse.edc.spi.result.Result
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset

class CachingOauth2ClientTest {
    private class MutableClock(
        var now: Instant = Instant.parse("2026-01-01T00:00:00Z"),
    ) : Clock() {
        override fun getZone() = ZoneOffset.UTC

        override fun withZone(zone: java.time.ZoneId) = this

        override fun instant() = now
    }

    private class CountingClient(
        private val expiresIn: Long?,
        private val fail: Boolean = false,
    ) : Oauth2Client {
        var calls = 0

        override fun requestToken(request: Oauth2CredentialsRequest): Result<TokenRepresentation> {
            calls++
            if (fail) return Result.failure("token endpoint down")
            val token =
                TokenRepresentation.Builder
                    .newInstance()
                    .token("t$calls")
                    .expiresIn(expiresIn)
                    .build()
            return Result.success(token)
        }
    }

    private fun sharedSecret(clientId: String = "client") =
        SharedSecretOauth2CredentialsRequest.Builder
            .newInstance()
            .url("https://idp.example.com/oauth2/token")
            .grantType("client_credentials")
            .clientId(clientId)
            .clientSecret("secret")
            .scope("api/read")
            .build()

    @Test
    fun `reuses the token until the refresh margin before expiry`() {
        val clock = MutableClock()
        val delegate = CountingClient(expiresIn = 3600)
        val client = CachingOauth2Client(delegate, clock)

        assertEquals("t1", client.requestToken(sharedSecret()).content.token)
        clock.now = clock.now.plus(Duration.ofSeconds(3600 - CachingOauth2Client.REFRESH_MARGIN_SECONDS - 1))
        assertEquals("t1", client.requestToken(sharedSecret()).content.token)
        clock.now = clock.now.plusSeconds(1)
        assertEquals("t2", client.requestToken(sharedSecret()).content.token)
        assertEquals(2, delegate.calls)
    }

    @Test
    fun `keys the cache by request parameters`() {
        val delegate = CountingClient(expiresIn = 3600)
        val client = CachingOauth2Client(delegate, MutableClock())

        client.requestToken(sharedSecret("a"))
        client.requestToken(sharedSecret("b"))
        client.requestToken(sharedSecret("a"))
        assertEquals(2, delegate.calls)
    }

    @Test
    fun `does not cache failures or tokens without expiry`() {
        val failing = CountingClient(expiresIn = 3600, fail = true)
        CachingOauth2Client(failing, MutableClock()).apply {
            requestToken(sharedSecret())
            requestToken(sharedSecret())
        }
        assertEquals(2, failing.calls)

        val noExpiry = CountingClient(expiresIn = null)
        CachingOauth2Client(noExpiry, MutableClock()).apply {
            requestToken(sharedSecret())
            requestToken(sharedSecret())
        }
        assertEquals(2, noExpiry.calls)
    }

    @Test
    fun `passes private key requests through`() {
        val delegate = CountingClient(expiresIn = 3600)
        val client = CachingOauth2Client(delegate, MutableClock())
        val request =
            PrivateKeyOauth2CredentialsRequest.Builder
                .newInstance()
                .url("https://idp.example.com/oauth2/token")
                .grantType("client_credentials")
                .clientAssertion("assertion")
                .build()

        client.requestToken(request)
        client.requestToken(request)
        assertEquals(2, delegate.calls)
    }
}
