// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "path";
import { CustomResource, Duration, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { Provider } from "aws-cdk-lib/custom-resources";

import type { PortalConnectorProperties } from "../portal-connector/handler";

/**
 * Provider of the PortalConnector custom resource, once per deployment.
 * The handler is the compiled `portal-connector` directory; it uses only
 * libraries the Lambda runtime provides.
 */
export class PortalConnectorProvider extends Construct {
  readonly serviceToken: string;

  constructor(scope: Construct, id: string, deploymentName: string) {
    super(scope, id);

    const { region, account } = Stack.of(this);
    const secretArn = `arn:aws:secretsmanager:${region}:${account}:secret:${deploymentName}`;
    const code = Code.fromAsset(resolve(__dirname, "../portal-connector"), {
      exclude: ["*.d.ts", "*.map"],
    });
    const handler = (name: string) =>
      new Function(this, name, {
        runtime: Runtime.NODEJS_24_X,
        handler: `handler.${name === "OnEvent" ? "onEvent" : "isComplete"}`,
        timeout: Duration.minutes(2),
        code,
        initialPolicy: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["secretsmanager:GetSecretValue"],
            resources: [`${secretArn}/portal-admin/*`],
          }),
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["secretsmanager:PutSecretValue"],
            resources: [`${secretArn}/*/edc.iam.sts.oauth.client.secret-*`],
          }),
        ],
      });

    // The Identity Wallet Management user takes minutes to become ACTIVE.
    const provider = new Provider(this, "Provider", {
      onEventHandler: handler("OnEvent"),
      isCompleteHandler: handler("IsComplete"),
      queryInterval: Duration.seconds(30),
      totalTimeout: Duration.hours(1),
    });
    this.serviceToken = provider.serviceToken;
  }
}

/** A connector's portal registration and technical user. */
export class PortalConnector extends Construct {
  /** OAuth client id of the connector's technical user. */
  readonly clientId: string;
  /** OAuth token URL of the connector's technical user. */
  readonly stsOauthTokenUrl: string;

  constructor(
    scope: Construct,
    id: string,
    props: { serviceToken: string; properties: PortalConnectorProperties },
  ) {
    super(scope, id);
    const resource = new CustomResource(this, "Resource", {
      serviceToken: props.serviceToken,
      resourceType: "Custom::PortalConnector",
      properties: { ...props.properties },
    });
    this.clientId = resource.getAttString("ClientId");
    this.stsOauthTokenUrl = resource.getAttString("StsOauthTokenUrl");
  }
}
