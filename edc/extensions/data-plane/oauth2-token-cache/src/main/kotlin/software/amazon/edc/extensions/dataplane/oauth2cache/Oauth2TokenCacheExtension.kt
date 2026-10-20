// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.oauth2cache

import org.eclipse.edc.iam.oauth2.spi.client.Oauth2Client
import org.eclipse.edc.runtime.metamodel.annotation.Extension
import org.eclipse.edc.runtime.metamodel.annotation.Inject
import org.eclipse.edc.runtime.metamodel.annotation.Provides
import org.eclipse.edc.spi.system.ServiceExtension
import org.eclipse.edc.spi.system.ServiceExtensionContext
import java.time.Clock

/**
 * Caches client-credentials tokens for OAuth2-secured HttpData sources.
 *
 * EDC's Oauth2HttpRequestParamsDecorator requests a new token for every data
 * request. This extension wraps the upstream Oauth2Client and replaces it in
 * the context. Injecting Oauth2Client orders it after the upstream provider;
 * declaring @Provides orders it before DataPlaneHttpOauth2Extension, which
 * therefore receives the caching client.
 */
@Extension(value = Oauth2TokenCacheExtension.NAME)
@Provides(Oauth2Client::class)
class Oauth2TokenCacheExtension : ServiceExtension {
    @Inject
    private lateinit var oauth2Client: Oauth2Client

    @Inject
    private lateinit var clock: Clock

    override fun name() = NAME

    override fun initialize(context: ServiceExtensionContext) {
        context.registerService(Oauth2Client::class.java, CachingOauth2Client(oauth2Client, clock))
        context.monitor.info("$NAME: caching client-credentials tokens until shortly before expiry")
    }

    companion object {
        const val NAME = "OAuth2 Token Cache"
    }
}
