// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

plugins {
    `java-library`
    alias(libs.plugins.shadow)
    alias(libs.plugins.swagger)
}

dependencies {
    runtimeOnly(libs.tx.controlplane.base)

    runtimeOnly(libs.edc.provision.aws.s3)
    runtimeOnly(libs.edc.transaction.local)
    runtimeOnly(libs.edc.vault.aws)

    runtimeOnly(libs.log4j.slf4j2.impl)
    runtimeOnly(libs.log4j.core)

    // Persistence variants, see the root build.gradle.kts.
    "ddb"(project(":extensions:control-plane:ddb"))

    "postgres"(libs.edc.bom.controlplane.feature.sql)
    "postgres"(libs.tx.store.agreements.retirement.sql)
    "postgres"(libs.tx.store.agreements.bpns.sql)
    "postgres"(libs.tx.store.bpn.validation.sql)
    "postgres"(libs.tx.store.edr.index.lock.sql)
    "postgres"(libs.tx.connector.migration)
    "postgres"(libs.postgres)
}
