// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CustomResource, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { Provider } from "aws-cdk-lib/custom-resources";

/**
 * Provider of the EdcTokenKeyPair custom resource, once per deployment. It
 * generates an EC P-256 key pair for EDR token signing in Secrets Manager and
 * deletes both secrets with the resource.
 */
export class EdcTokenKeyPairProvider extends Construct {
  readonly serviceToken: string;

  constructor(scope: Construct, id: string, deploymentName: string) {
    super(scope, id);

    const handler = new Function(this, "Handler", {
      runtime: Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: Code.fromInline(`
const { generateKeyPairSync } = require("crypto");
const {
  SecretsManagerClient,
  CreateSecretCommand,
  DeleteSecretCommand,
} = require("@aws-sdk/client-secrets-manager");

exports.handler = async (event) => {
  const sm = new SecretsManagerClient();
  const privName = event.ResourceProperties.PrivateKeySecretName;
  const pubName = event.ResourceProperties.PublicKeySecretName;

  if (event.RequestType === "Delete") {
    for (const name of [privName, pubName]) {
      try {
        await sm.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }));
      } catch (e) {
        if (e.name !== "ResourceNotFoundException") throw e;
      }
    }
  } else if (event.RequestType === "Create") {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    await sm.send(new CreateSecretCommand({ Name: privName, SecretString: privateKey }));
    await sm.send(new CreateSecretCommand({ Name: pubName, SecretString: publicKey }));
  }
  return {};
};
`),
    });

    const { region, account } = Stack.of(this);
    handler.addToRolePolicy(
      new PolicyStatement({
        actions: ["secretsmanager:CreateSecret", "secretsmanager:DeleteSecret"],
        effect: Effect.ALLOW,
        resources: [
          `arn:aws:secretsmanager:${region}:${account}:secret:${deploymentName}/*/edc.transfer.proxy.token.*`,
        ],
      }),
    );

    this.serviceToken = new Provider(this, "Provider", {
      onEventHandler: handler,
    }).serviceToken;
  }
}

/** A connector's EDR token signing key pair. */
export class EdcTokenKeyPair extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: {
      serviceToken: string;
      privateKeySecretName: string;
      publicKeySecretName: string;
    },
  ) {
    super(scope, id);
    new CustomResource(this, "Resource", {
      serviceToken: props.serviceToken,
      properties: {
        PrivateKeySecretName: props.privateKeySecretName,
        PublicKeySecretName: props.publicKeySecretName,
      },
    });
  }
}
