// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb.utility

import org.eclipse.edc.spi.query.Criterion
import org.eclipse.edc.spi.query.CriterionOperatorRegistry
import org.eclipse.edc.spi.query.QuerySpec
import org.eclipse.edc.spi.query.SortOrder
import software.amazon.awssdk.enhanced.dynamodb.Expression
import software.amazon.awssdk.enhanced.dynamodb.model.ScanEnhancedRequest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import java.util.function.Predicate
import kotlin.reflect.KClass
import kotlin.reflect.full.memberProperties

fun <T> Collection<Criterion>.toPredicate(criterionOperatorRegistry: CriterionOperatorRegistry): Predicate<T> =
    map { criterionOperatorRegistry.toPredicate<T>(it) }.reduceOrNull(Predicate<T>::and) ?: Predicate<T> { true }

/**
 * This scan request does not work for all queries that QuerySpec may allow for. In particular, ILIKE operations and
 * queries against complex nested objects in a properties field will not work in all situations. This scan request is
 * still useful for offloading queries to DynamoDB where those things do not need to be supported.
 */
fun QuerySpec.toScanRequest(fieldNameReplacements: Map<String, String> = emptyMap()): ScanEnhancedRequest {
    val resultingFilterExpression = StringBuilder()
    val expressionNames = mutableMapOf<String, String>()
    val expressionValues = mutableMapOf<String, AttributeValue>()

    if (filterExpression.isNotEmpty()) {
        val expressions = mutableListOf<String>()

        filterExpression.forEachIndexed { index, criterion ->
            val attributeName = "#attr$index"
            val placeholder = ":val$index"
            val fieldName = fieldNameReplacements[criterion.operandLeft.toString()] ?: criterion.operandLeft.toString()

            expressionNames[attributeName] = fieldName
            when (criterion.operator.lowercase()) {
                "like" -> {
                    expressionValues[placeholder] =
                        AttributeValue.builder().s(criterion.getSanitizedOperandRight()).build()
                    expressions.add("contains($attributeName, $placeholder)")
                }
                else -> {
                    expressionValues[placeholder] = criterion.operandRight.toAttributeValue()
                    expressions.add("$attributeName ${criterion.getDdbOperator()} $placeholder")
                }
            }
        }

        resultingFilterExpression.append(expressions.joinToString(" AND "))
    }

    val builder = ScanEnhancedRequest.builder()
    if (resultingFilterExpression.isNotEmpty()) {
        builder.filterExpression(
            Expression.builder()
                .expression(resultingFilterExpression.toString())
                .expressionNames(expressionNames)
                .expressionValues(expressionValues)
                .build(),
        )
    }
    return builder.build()
}

@Suppress("UNCHECKED_CAST")
fun <T> QuerySpec.getGenericPropertyComparator(): Comparator<T> =
    Comparator { a, b ->
        if (sortField == null) {
            return@Comparator 0
        }

        val aValue = getSortFieldValue(a)
        val bValue = getSortFieldValue(b)

        return@Comparator when {
            aValue == null && bValue == null -> 0
            aValue == null -> if (sortOrder == SortOrder.ASC) -1 else 1
            bValue == null -> if (sortOrder == SortOrder.ASC) 1 else -1
            else ->
                if (aValue is Comparable<*>) {
                    val comparison = (aValue as Comparable<Any>).compareTo(bValue)
                    if (sortOrder == SortOrder.ASC) comparison else -comparison
                } else {
                    throw IllegalArgumentException("Property $sortField=$aValue is not comparable!")
                }
        }
    }

private fun <T> QuerySpec.getSortFieldValue(obj: T): Any? =
    try {
        var clazz: Class<*>? = obj!!::class.java
        var field: java.lang.reflect.Field? = null
        while (clazz != null && field == null) {
            field =
                try {
                    clazz.getDeclaredField(sortField)
                } catch (_: NoSuchFieldException) {
                    null
                }
            clazz = clazz.superclass
        }
        field?.isAccessible = true
        field?.get(obj) ?: throw NoSuchFieldException(sortField)
    } catch (e: Exception) {
        throw IllegalArgumentException("$sortField is not a valid sort field!")
    }

private fun Criterion.getDdbOperator(): String =
    when (operator.lowercase()) {
        "=" -> "="
        "!=" -> "<>"
        ">" -> ">"
        ">=" -> ">="
        "<" -> "<"
        "<=" -> "<="
        "in" -> "IN"
        "like" -> "contains"
        else -> throw IllegalArgumentException("Unsupported operator: $operator")
    }

private fun Criterion.getSanitizedOperandRight(): String {
    return operandRight.toString().replace("%", "")
}

private fun Any?.toAttributeValue(): AttributeValue {
    val builder = AttributeValue.builder()
    when (this) {
        null -> builder.nul(true)
        is String -> builder.s(this)
        is Number -> builder.n(toString())
        is Boolean -> builder.bool(this)
        else -> throw IllegalArgumentException("Unsupported value: $this")
    }
    return builder.build()
}

fun KClass<*>.hasProperty(propertyName: String): Boolean = memberProperties.any { it.name == propertyName }
