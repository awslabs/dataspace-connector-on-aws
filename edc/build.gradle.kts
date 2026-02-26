// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

plugins {
    `java-library`
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
}
