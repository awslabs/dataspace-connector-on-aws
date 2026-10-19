// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AuroraPostgresEngineVersion } from "aws-cdk-lib/aws-rds";

/**
 * Pinned container images for the BaSyx stack. Each digest is the multi-arch
 * image index (arm64 included), resolved from the registry on 2026-10-19.
 * Bump the version and all digests together.
 */
export const BASYX_VERSION = "1.1.2";

export const BASYX_IMAGES = {
  dtr: `eclipsebasyx/digitaltwinregistry-go:${BASYX_VERSION}@sha256:c22761fd659801183c6cb73048b45b96e78c760b27548ae9d877f3c59d523567`,
  submodelRepository: `eclipsebasyx/submodelrepository-go:${BASYX_VERSION}@sha256:1ce0d3ed4bbf090e130799d8082b79ba44bcbd73e13f969db9acb4ac30af80cc`,
  configurationService: `eclipsebasyx/basyxconfigurationservice-go:${BASYX_VERSION}@sha256:b8afd6932d763607f7e4d40ced8b1865d40aadc17d816a48f3c263fda3c81f74`,
} as const;

/** Writes the access rules and trust list into the task's shared volume. */
export const BUSYBOX_IMAGE =
  "public.ecr.aws/docker/library/busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";

/** Creates the Submodel Repository database on first start. */
export const POSTGRES_CLIENT_IMAGE =
  "public.ecr.aws/docker/library/postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";

/**
 * Aurora PostgreSQL engine version: the newest one aws-cdk-lib types
 * (BaSyx requires PostgreSQL 16 or newer).
 */
export const AURORA_POSTGRES_VERSION = AuroraPostgresEngineVersion.VER_18_4;
