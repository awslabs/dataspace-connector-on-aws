// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

plugins {
    `java-library`
    application
    alias(libs.plugins.shadow)
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

application {
    mainClass.set("org.eclipse.edc.boot.system.runtime.BaseRuntime")
}

tasks {
    shadowJar {
        mergeServiceFiles()
        archiveFileName.set("control-plane.jar")
        isZip64 = true
    }

    distTar { dependsOn(shadowJar) }
    distZip { dependsOn(shadowJar) }
    startScripts { dependsOn(shadowJar) }
    named("startShadowScripts") { dependsOn(jar) }
}
