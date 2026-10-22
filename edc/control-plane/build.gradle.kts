// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

plugins {
    `java-library`
    alias(libs.plugins.shadow)
    alias(libs.plugins.swagger)
}

dependencies {
    runtimeOnly(libs.tx.controlplane.base)
    runtimeOnly(project(":extensions:control-plane:ddb"))

    runtimeOnly(libs.edc.provision.aws.s3)
    runtimeOnly(libs.edc.transaction.local)
    runtimeOnly(libs.edc.vault.aws)

    runtimeOnly(libs.log4j.slf4j2.impl)
    runtimeOnly(libs.log4j.core)
}
