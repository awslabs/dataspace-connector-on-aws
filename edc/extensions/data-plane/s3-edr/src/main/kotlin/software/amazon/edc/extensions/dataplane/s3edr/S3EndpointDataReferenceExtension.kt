// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.dataplane.s3edr

import org.eclipse.edc.connector.dataplane.spi.edr.EndpointDataReferenceService
import org.eclipse.edc.connector.dataplane.spi.edr.EndpointDataReferenceServiceRegistry
import org.eclipse.edc.connector.dataplane.spi.iam.DataPlaneAuthorizationService
import org.eclipse.edc.runtime.metamodel.annotation.Extension
import org.eclipse.edc.runtime.metamodel.annotation.Inject
import org.eclipse.edc.spi.system.ServiceExtension
import org.eclipse.edc.spi.system.ServiceExtensionContext

/**
 * Registers the EDR service for the "AmazonS3" source address type.
 *
 * EDC 0.15.x keys pull EDR generation by the source address type
 * (EndpointDataReferenceServiceRegistry.create uses dataFlow.getSource()), but only
 * DataPlaneIamExtension registers a service, hardcoded to "HttpData". Without this,
 * a consumer HttpData-PULL of an S3-source asset fails with
 * "No EDR service with type AmazonS3 found". The registered DataPlaneAuthorizationService
 * is source-agnostic (it mints the public-API endpoint and token), so reusing it for the
 * AmazonS3 source type enables S3 proxy pulls without any fork of upstream EDC.
 */
@Extension(value = S3EndpointDataReferenceExtension.NAME)
class S3EndpointDataReferenceExtension : ServiceExtension {
    @Inject
    private lateinit var authorizationService: DataPlaneAuthorizationService

    @Inject
    private lateinit var edrServiceRegistry: EndpointDataReferenceServiceRegistry

    override fun name() = NAME

    override fun initialize(context: ServiceExtensionContext) {
        val edrService = authorizationService as EndpointDataReferenceService
        edrServiceRegistry.register(AMAZON_S3, edrService)
        edrServiceRegistry.registerResponseChannel(AMAZON_S3, edrService)
        context.monitor.info("$NAME: registered EDR service for source type '$AMAZON_S3'")
    }

    companion object {
        const val NAME = "AmazonS3 EDR Service"

        // Matches org.eclipse.edc.aws.s3.spi.S3BucketSchema.TYPE
        private const val AMAZON_S3 = "AmazonS3"
    }
}
