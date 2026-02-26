// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "fs";
import yaml from "js-yaml";

import { ApiDefinition, IRestApi } from "aws-cdk-lib/aws-apigateway";

/*
  API Gateway has a hard limit on 5 TPS when creating and modifying APIs. Hitting this limit results in failures
  in CloudFormation because it doesn't throttle itself when executing an API Gateway change. This function makes
  each API dependent on another API (except for the first) to force CloudFormation to apply changes serially.
  https://github.com/aws-cloudformation/cloudformation-coverage-roadmap/issues/1095
*/
export function applyApiGatewayWorkaround(apis: IRestApi[]) {
  let lastApi: IRestApi;
  apis.forEach((api) => {
    if (lastApi) api.node.addDependency(lastApi);
    lastApi = api;
  });
}

export function getApiDefinitionTransform(
  filePath: string,
  loadBalancerDnsName: string,
  vpcLinkId: string,
): ApiDefinition {
  let apiSpec = JSON.stringify(
    yaml.load(fs.readFileSync(filePath, { encoding: "utf-8" })),
  );
  apiSpec = apiSpec.replace(/\${loadBalancerDnsName}/g, loadBalancerDnsName);
  apiSpec = apiSpec.replace(/\${vpcLinkId}/g, vpcLinkId);
  return ApiDefinition.fromInline(JSON.parse(apiSpec));
}
