// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import org.jlleitschuh.gradle.ktlint.KtlintExtension
import org.jlleitschuh.gradle.ktlint.reporter.ReporterType

plugins {
    `java-library`
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.ktlint)
}

dependencies {
    implementation(project(":extensions:common:ddb"))
    implementation(libs.aws.sdk.dynamodb)
    implementation(libs.aws.sdk.dynamodb.enhanced)
    implementation(libs.edc.controlplane.core)
    implementation(libs.edc.lib.query)
    implementation(libs.edc.lib.store)
    implementation(libs.edc.spi.asset)
    implementation(libs.edc.spi.core)
    api(libs.edc.spi.dataplane.selector)
    implementation(libs.edc.spi.policy.monitor)
    implementation(libs.edc.spi.store.edr)
    implementation(libs.jackson.module.kotlin)
    implementation(libs.tx.spi.bpn.validation)

    testImplementation(libs.aws.dynamodb.local)
    testImplementation(libs.junit.jupiter)

    testImplementation(testFixtures(libs.edc.spi.asset))
    testImplementation(testFixtures(libs.edc.spi.contract))
    testImplementation(testFixtures(libs.edc.spi.dataplane.selector))
    testImplementation(testFixtures(libs.edc.spi.policy))
    testImplementation(testFixtures(libs.edc.spi.policy.monitor))
    testImplementation(testFixtures(libs.edc.spi.transfer))
    testImplementation(testFixtures(libs.tx.core.bpn.validation))
}

configure<KtlintExtension> {
    reporters {
        reporter(ReporterType.PLAIN)
        reporter(ReporterType.CHECKSTYLE)
    }
    enableExperimentalRules = false
    ignoreFailures = false
}
