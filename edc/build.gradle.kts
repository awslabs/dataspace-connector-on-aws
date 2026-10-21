// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar
import com.github.jengelman.gradle.plugins.shadow.transformers.Log4j2PluginsCacheFileTransformer

plugins {
    `java-library`
    alias(libs.plugins.shadow) apply false
}

allprojects {
    repositories {
        mavenCentral()
    }
}

subprojects {
    plugins.withType<JavaPlugin> {
        java {
            toolchain {
                languageVersion = JavaLanguageVersion.of(17)
            }
        }
    }

    // Reproducible jars keep the CDK DockerImageAsset hash stable across runs,
    // so connectors aren't redeployed on config-only changes.
    tasks.withType<AbstractArchiveTask>().configureEach {
        isPreserveFileTimestamps = false
        isReproducibleFileOrder = true
    }

    // The control-plane and data-plane runtimes: one fat jar each, with the
    // shared Log4j 2 config (edc/logging/log4j2.xml).
    plugins.withId("com.gradleup.shadow") {
        the<SourceSetContainer>()["main"].resources.srcDir(rootProject.file("logging"))
        tasks.named<ShadowJar>("shadowJar") {
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
}
