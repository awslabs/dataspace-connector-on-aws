// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

plugins {
    `java-library`
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.ktlint)
}

dependencies {
    implementation(libs.aws.sdk.dynamodb)
    implementation(libs.aws.sdk.dynamodb.enhanced)
    implementation(libs.edc.spi.store.edr)
    implementation(libs.edc.spi.validator)
    implementation(libs.kotlin.reflect)

    testImplementation(libs.aws.dynamodb.local)
    testImplementation(libs.edc.lib.query)
    testImplementation(libs.junit.jupiter)
    testImplementation(testFixtures(libs.edc.spi.store.edr))
}
