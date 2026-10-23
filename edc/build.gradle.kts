// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar
import com.github.jengelman.gradle.plugins.shadow.transformers.Log4j2PluginsCacheFileTransformer
import io.swagger.v3.plugins.gradle.tasks.ResolveTask

plugins {
    alias(libs.plugins.shadow) apply false
    alias(libs.plugins.swagger) apply false
}

subprojects {
    repositories {
        mavenCentral()
    }

    plugins.withType<JavaPlugin> {
        configure<JavaPluginExtension> {
            toolchain.languageVersion = JavaLanguageVersion.of(17)
        }
        tasks.withType<Test> {
            useJUnitPlatform()
        }
        dependencies.add("testRuntimeOnly", libs.junit.platform.launcher)
    }

    // Reproducible jars keep the CDK DockerImageAsset hash stable across runs,
    // so connectors aren't redeployed on config-only changes.
    tasks.withType<AbstractArchiveTask>().configureEach {
        isPreserveFileTimestamps = false
        isReproducibleFileOrder = true
    }

    // The control-plane and data-plane runtimes: one fat jar each, with the
    // shared Log4j 2 config, and the OpenAPI document the API specs are
    // generated from (scripts/regenerate-api-specs.py).
    plugins.withId("com.gradleup.shadow") {
        the<SourceSetContainer>()["main"].resources.srcDir(rootProject.file("logging"))
        tasks.named<ShadowJar>("shadowJar") {
            archiveFileName.set("${project.name}.jar")
            isZip64 = true
            manifest.attributes["Main-Class"] = "org.eclipse.edc.boot.system.runtime.BaseRuntime"
            mergeServiceFiles()
            // Merge the Log4j 2 plugin caches; an overwritten cache stops any config from loading.
            transform<Log4j2PluginsCacheFileTransformer>()
            // Drop the log4j2.json (Root OFF) from tractusx log4j2-monitor; JSON outranks XML.
            exclude("log4j2.json")
            filesMatching(
                listOf(
                    "META-INF/services/**",
                    "META-INF/org/apache/logging/log4j/core/config/plugins/Log4j2Plugins.dat",
                ),
            ) {
                duplicatesStrategy = DuplicatesStrategy.INCLUDE
            }
        }
    }

    plugins.withId("io.swagger.core.v3.swagger-gradle-plugin") {
        tasks.register<ResolveTask>("resolveApi") {
            outputFileName.set("${project.name}-openapi")
            outputFormat.set(ResolveTask.Format.JSON)
            prettyPrint.set(true)
            classpath = project.the<SourceSetContainer>()["main"].runtimeClasspath
            buildClasspath = classpath
            resourcePackages.set(setOf("org.eclipse.edc", "org.eclipse.tractusx", "software.amazon.edc"))
            outputDir.set(layout.buildDirectory.dir("openapi").get().asFile)
            readAllResources.set(true)
            sortOutput.set(true)
            skipResolveAppPath.set(true)
        }
    }
}
