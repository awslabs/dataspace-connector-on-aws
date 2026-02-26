// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

plugins {
    `java-library`
    application
    id("com.github.johnrengelman.shadow") version "8.1.1"
}

dependencies {
    runtimeOnly(libs.tx.dataplane.base)
    runtimeOnly(project(":extensions:data-plane:ddb"))

    runtimeOnly(libs.edc.dpf.awss3.validator)
    runtimeOnly(libs.edc.transaction.local)
    runtimeOnly(libs.edc.vault.aws)

    runtimeOnly(libs.log4j.slf4j2.impl)
    runtimeOnly(libs.log4j.core)
}

application {
    mainClass.set("org.eclipse.edc.boot.system.runtime.BaseRuntime")
}

tasks.shadowJar {
    mergeServiceFiles()
    archiveFileName.set("data-plane.jar")
    isZip64 = true
}
