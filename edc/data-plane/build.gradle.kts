// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

plugins {
    `java-library`
    alias(libs.plugins.shadow)
    alias(libs.plugins.swagger)
}

dependencies {
    runtimeOnly(libs.tx.dataplane.base)
    runtimeOnly(project(":extensions:data-plane:oauth2-token-cache"))
    runtimeOnly(project(":extensions:data-plane:s3-edr"))

    runtimeOnly(libs.edc.dpf.awss3.validator)
    runtimeOnly(libs.edc.transaction.local)
    runtimeOnly(libs.edc.vault.aws)

    runtimeOnly(libs.log4j.slf4j2.impl)
    runtimeOnly(libs.log4j.core)

    // Persistence variants, see the root build.gradle.kts.
    "ddb"(project(":extensions:data-plane:ddb"))

    "postgres"(libs.edc.bom.dataplane.feature.sql)
    "postgres"(libs.edc.edr.index.sql)
    "postgres"(libs.tx.connector.migration)
    "postgres"(libs.postgres)
}
