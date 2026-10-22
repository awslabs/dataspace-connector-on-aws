// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "fs";
import yaml from "js-yaml";

import { ApiDefinition } from "aws-cdk-lib/aws-apigateway";

/** Loads an OpenAPI spec and substitutes its `${name}` placeholders. */
export function apiDefinition(
  filePath: string,
  values: Record<string, string>,
): ApiDefinition {
  let spec = JSON.stringify(yaml.load(fs.readFileSync(filePath, "utf-8")));
  for (const [name, value] of Object.entries(values)) {
    spec = spec.replaceAll(`\${${name}}`, value);
  }
  return ApiDefinition.fromInline(JSON.parse(spec));
}
