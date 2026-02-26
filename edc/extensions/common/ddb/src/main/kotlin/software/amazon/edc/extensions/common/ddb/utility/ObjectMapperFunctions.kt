// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb.utility

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.ObjectMapper
import org.eclipse.edc.policy.model.AndConstraint
import org.eclipse.edc.policy.model.AtomicConstraint
import org.eclipse.edc.policy.model.LiteralExpression
import org.eclipse.edc.policy.model.OrConstraint
import org.eclipse.edc.policy.model.XoneConstraint

fun ObjectMapper.convertValueToMapStringAny(value: Any): Map<String, Any> =
    convertValue(value, object : TypeReference<Map<String, Any>>() {})

fun ObjectMapper.registerConstraintSubtypes() {
    registerSubtypes(
        AtomicConstraint::class.java,
        AndConstraint::class.java,
        OrConstraint::class.java,
        XoneConstraint::class.java,
        LiteralExpression::class.java,
    )
}
