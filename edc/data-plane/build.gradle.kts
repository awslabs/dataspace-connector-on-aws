// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import org.gradle.api.file.DuplicatesStrategy

plugins {
    `java-library`
    application
    alias(libs.plugins.shadow)
    id("io.swagger.core.v3.swagger-gradle-plugin") version "2.2.30"
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

tasks {
    shadowJar {
        mergeServiceFiles()
        filesMatching("META-INF/services/**") {
            duplicatesStrategy = DuplicatesStrategy.INCLUDE
        }
        archiveFileName.set("data-plane.jar")
        isZip64 = true
    }
    distTar { dependsOn(shadowJar) }
    distZip { dependsOn(shadowJar) }
    startScripts { dependsOn(shadowJar) }
    named("startShadowScripts") { dependsOn(jar) }
}

val swaggerResourcePackages = setOf("org.eclipse.edc", "org.eclipse.tractusx", "software.amazon.edc")
tasks.register("resolveApi", io.swagger.v3.plugins.gradle.tasks.ResolveTask::class) {
    outputFileName.set("data-plane-openapi")
    outputFormat.set(io.swagger.v3.plugins.gradle.tasks.ResolveTask.Format.JSON)
    prettyPrint.set(true)
    classpath = sourceSets["main"].runtimeClasspath
    buildClasspath = classpath
    resourcePackages.set(swaggerResourcePackages)
    outputDir.set(file(layout.buildDirectory.dir("openapi").get().asFile))
    readAllResources.set(true)
    sortOutput.set(true)
    skipResolveAppPath.set(true)
    alwaysResolveAppPath.set(false)
    encoding.set("UTF-8")
    skip.set(false)
}
