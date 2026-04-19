// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import software.amazon.awssdk.core.SdkBytes
import software.amazon.awssdk.services.dynamodb.model.AttributeValue

class MapStringAnyConverterTest {
    private val converter = MapStringAnyConverter()

    @Test
    fun unsupportedTypes() {
        assertThrows<IllegalArgumentException> { converter.transformFrom(mapOf("key" to Pair("first", "second"))) }
        assertThrows<IllegalArgumentException> {
            converter
                .transformTo(
                    AttributeValue
                        .builder()
                        .m(mapOf("data" to AttributeValue.fromB(SdkBytes.fromUtf8String("some binary data"))))
                        .build(),
                ).also { println("Result: $it") }
        }
    }
}
