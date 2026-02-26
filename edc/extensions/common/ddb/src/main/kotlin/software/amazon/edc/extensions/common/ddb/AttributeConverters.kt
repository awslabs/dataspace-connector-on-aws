// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb

import software.amazon.awssdk.enhanced.dynamodb.AttributeConverter
import software.amazon.awssdk.enhanced.dynamodb.AttributeValueType
import software.amazon.awssdk.enhanced.dynamodb.EnhancedType
import software.amazon.awssdk.services.dynamodb.model.AttributeValue

class MapStringAnyConverter : AttributeConverter<Map<String, Any?>> {
    override fun transformFrom(input: Map<String, Any?>?): AttributeValue =
        input?.toMapAttributeValue() ?: AttributeValue.builder().nul(true).build()

    override fun transformTo(input: AttributeValue?): Map<String, Any?> = input?.toMap() ?: emptyMap()

    @Suppress("UNCHECKED_CAST")
    override fun type(): EnhancedType<Map<String, Any?>> = EnhancedType.of(Map::class.java) as EnhancedType<Map<String, Any?>>

    override fun attributeValueType(): AttributeValueType = AttributeValueType.M
}

class ListOfMapsConverter : AttributeConverter<List<Map<String, Any?>>> {
    override fun transformFrom(input: List<Map<String, Any?>>?): AttributeValue =
        if (input == null) {
            AttributeValue.builder().nul(true).build()
        } else {
            AttributeValue.builder().l(input.map { it.toAttributeValue() }).build()
        }

    override fun transformTo(input: AttributeValue?): List<Map<String, Any?>> = input?.l()?.map { it.toMap() }?.toList() ?: emptyList()

    @Suppress("UNCHECKED_CAST")
    override fun type(): EnhancedType<List<Map<String, Any?>>> = EnhancedType.of(List::class.java) as EnhancedType<List<Map<String, Any?>>>

    override fun attributeValueType(): AttributeValueType = AttributeValueType.L
}

private fun Map<String, Any?>.toMapAttributeValue(): AttributeValue =
    AttributeValue.builder().m(
        mapNotNull { it.value?.let { value -> it.key to value } }.toMap()
            .mapValues { (_, value) -> value.toAttributeValue() },
    ).build()

@Suppress("UNCHECKED_CAST")
private fun Any?.toAttributeValue(): AttributeValue =
    when (this) {
        null -> AttributeValue.builder().nul(true).build()
        is Boolean -> AttributeValue.fromBool(this)
        is Number -> AttributeValue.fromN(this.toString())
        is String -> AttributeValue.fromS(this)
        is List<*> -> AttributeValue.fromL(mapNotNull { it?.toAttributeValue() })
        is Map<*, *> -> (this as Map<String, Any>).toMapAttributeValue()
        else -> throw IllegalArgumentException("Unsupported type: ${this::class}")
    }

private fun AttributeValue.toMap(): Map<String, Any?> =
    m()?.filter { it.value.type() != AttributeValue.Type.NUL }
        ?.mapValues { (_, attributeValue) -> attributeValue.toValue() } ?: emptyMap()

private fun AttributeValue.toValue(): Any? =
    when (type()) {
        AttributeValue.Type.BOOL -> bool()
        AttributeValue.Type.N -> n().toIntOrNull() ?: n().toLongOrNull() ?: n().toDoubleOrNull() ?: n()
        AttributeValue.Type.S -> s()
        AttributeValue.Type.L -> l().mapNotNull { it.toValue() }
        AttributeValue.Type.M -> toMap()
        AttributeValue.Type.NUL -> null
        else -> throw IllegalArgumentException("Unsupported type: ${type()}")
    }
