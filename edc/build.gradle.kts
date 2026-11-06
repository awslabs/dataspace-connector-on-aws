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

    // The control-plane and data-plane runtimes: one fat jar per persistence
    // and plane, with the shared Log4j 2 config, and the OpenAPI document the
    // API specs are generated from (scripts/regenerate-api-specs.py).
    //
    // EDC loads every extension on the classpath and has no setting to disable
    // one, so the store choice is a classpath choice. `runtimeOnly` holds what
    // both variants share; `ddb` and `postgres` hold what differs:
    //   shadowJar          -> <project>.jar           (runtimeOnly + ddb)
    //   postgresShadowJar  -> <project>-postgres.jar  (runtimeOnly + postgres)
    // postgresShadowJar is deliberately not wired into assemble/build.
    plugins.withId("com.gradleup.shadow") {
        val mainSourceSet = the<SourceSetContainer>()["main"]
        mainSourceSet.resources.srcDir(rootProject.file("logging"))

        val ddb =
            configurations.create("ddb") {
                isCanBeResolved = false
                isCanBeConsumed = false
            }
        val postgres =
            configurations.create("postgres") {
                isCanBeResolved = false
                isCanBeConsumed = false
            }

        // The default classpath stays the DynamoDB variant.
        val runtimeClasspath = configurations.getByName("runtimeClasspath")
        runtimeClasspath.extendsFrom(ddb)

        // Common + PostgreSQL dependencies resolve as one graph, so version
        // alignment and conflict resolution see everything that ends up in the jar.
        val postgresRuntimeClasspath =
            configurations.create("postgresRuntimeClasspath") {
                isCanBeConsumed = false
                extendsFrom(configurations.getByName("runtimeOnly"), postgres)
                attributes {
                    runtimeClasspath.attributes.keySet().forEach { key ->
                        @Suppress("UNCHECKED_CAST")
                        attribute(key as Attribute<Any>, runtimeClasspath.attributes.getAttribute(key)!!)
                    }
                }
            }

        tasks.withType<ShadowJar>().configureEach {
            isZip64 = true
            manifest.attributes["Main-Class"] = "org.eclipse.edc.boot.system.runtime.BaseRuntime"
            mergeServiceFiles()
            // Merge the Log4j 2 plugin caches; an overwritten cache stops any config from loading.
            transform<Log4j2PluginsCacheFileTransformer>()
            // Drop the log4j2.json (Root OFF) from tractusx log4j2-monitor; JSON outranks XML.
            exclude("log4j2.json")
            // The plugin applies these to `shadowJar` only; a task registered here would
            // keep dependency signature files, which the JVM rejects on the merged jar.
            exclude(
                "META-INF/INDEX.LIST",
                "META-INF/*.SF",
                "META-INF/*.DSA",
                "META-INF/*.RSA",
                "META-INF/versions/**/module-info.class",
                "module-info.class",
            )
            filesMatching(
                listOf(
                    "META-INF/services/**",
                    "META-INF/org/apache/logging/log4j/core/config/plugins/Log4j2Plugins.dat",
                ),
            ) {
                duplicatesStrategy = DuplicatesStrategy.INCLUDE
            }
        }

        tasks.named<ShadowJar>("shadowJar") {
            archiveFileName.set("${project.name}.jar")
        }

        tasks.register<ShadowJar>("postgresShadowJar") {
            group = "build"
            description = "Assembles the fat jar with the PostgreSQL stores instead of the DynamoDB ones."
            archiveFileName.set("${project.name}-postgres.jar")
            // Brings the shared log4j2.xml and any local resources.
            from(mainSourceSet.output)
            this.configurations.set(listOf(postgresRuntimeClasspath))
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
