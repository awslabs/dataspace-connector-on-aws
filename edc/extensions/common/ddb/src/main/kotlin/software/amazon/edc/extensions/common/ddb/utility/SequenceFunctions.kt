// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.common.ddb.utility

import org.eclipse.edc.spi.query.QuerySpec

fun <T> Sequence<T>.applyOffsetAndLimit(querySpec: QuerySpec): Sequence<T> = drop(querySpec.offset).take(querySpec.limit)
