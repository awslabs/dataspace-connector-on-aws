// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

plugins {
    `java-library`
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.ktlint)
}

dependencies {
    implementation(project(":extensions:common:ddb"))

    implementation(libs.aws.sdk.dynamodb)
    implementation(libs.aws.sdk.dynamodb.enhanced)
    implementation(libs.edc.lib.query)
    implementation(libs.edc.spi.dataplane)
    implementation(libs.edc.spi.store.edr)

    testImplementation(libs.aws.dynamodb.local)
    testImplementation(libs.junit.jupiter)

    testImplementation(testFixtures(libs.edc.spi.dataplane))
}
