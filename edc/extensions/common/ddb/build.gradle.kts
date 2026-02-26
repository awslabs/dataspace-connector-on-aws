// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import org.gradle.api.tasks.testing.logging.TestLogEvent
import org.jlleitschuh.gradle.ktlint.KtlintExtension
import org.jlleitschuh.gradle.ktlint.reporter.ReporterType

plugins {
    `java-library`
    id("org.jetbrains.kotlin.jvm") version "2.0.+"
    id("org.jlleitschuh.gradle.ktlint") version "12.1.+"
}

repositories {
    mavenCentral()
}

dependencies {
    implementation(libs.aws.sdk.dynamodb)
    implementation(libs.aws.sdk.dynamodb.enhanced)
    implementation(libs.edc.spi.store.edr)
    implementation(libs.edc.spi.validator)
    implementation(libs.kotlin.reflect)
    implementation(libs.kotlin.stdlib)

    testImplementation(libs.aws.dynamodb.local)
    testImplementation(libs.junit.jupiter)
    testImplementation(testFixtures(libs.edc.spi.store.edr))
}

configure<KtlintExtension> {
    reporters {
        reporter(ReporterType.PLAIN)
        reporter(ReporterType.CHECKSTYLE)
    }
    enableExperimentalRules = false
    ignoreFailures = false
}

java {
    withSourcesJar()
}

tasks {
    jar {
        archiveBaseName.set("edc-extension-common-ddb")
    }

    withType<Test> {
        maxParallelForks = Runtime.getRuntime().availableProcessors()
        useJUnitPlatform()
        testLogging {
            events = setOf(TestLogEvent.FAILED, TestLogEvent.PASSED, TestLogEvent.SKIPPED)
        }
    }
}
