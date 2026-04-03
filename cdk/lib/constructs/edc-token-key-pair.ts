// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CustomResource, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { Provider } from "aws-cdk-lib/custom-resources";

export interface EdcTokenKeyPairProps {
  readonly privateKeySecretName: string;
  readonly publicKeySecretName: string;
}

/**
 * Generates an EC P-256 key pair for EDC data plane EDR token signing
 * and stores both keys in AWS Secrets Manager.
 *
 * Key material is generated inside a Lambda function at deploy time
 * and never leaves AWS. On stack deletion, both secrets are removed.
 */
export class EdcTokenKeyPair extends Construct {
  constructor(scope: Construct, id: string, props: EdcTokenKeyPairProps) {
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
        await sm.send(
          new DeleteSecretCommand({
            SecretId: name,
            ForceDeleteWithoutRecovery: true,
          }),
        );
      } catch (e) {
        if (e.name !== "ResourceNotFoundException") throw e;
      }
    }
    return {};
  }

  if (event.RequestType === "Create") {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    await sm.send(
      new CreateSecretCommand({
        Name: privName,
        SecretString: privateKey,
        Description: "EC private key for EDR token signing",
      }),
    );
    await sm.send(
      new CreateSecretCommand({
        Name: pubName,
        SecretString: publicKey,
        Description: "EC public key for EDR token verification",
      }),
    );
  }

  return {};
};
`),
      description:
        "Generates EC P-256 key pair for EDC data plane token signing",
    });

    const stack = Stack.of(this);
    const secretArnPrefix = `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:`;

    handler.addToRolePolicy(
      new PolicyStatement({
        actions: ["secretsmanager:CreateSecret", "secretsmanager:DeleteSecret"],
        effect: Effect.ALLOW,
        resources: [
          `${secretArnPrefix}${props.privateKeySecretName}-*`,
          `${secretArnPrefix}${props.publicKeySecretName}-*`,
        ],
      }),
    );

    const provider = new Provider(this, "Provider", {
      onEventHandler: handler,
    });

    new CustomResource(this, "Resource", {
      serviceToken: provider.serviceToken,
      properties: {
        PrivateKeySecretName: props.privateKeySecretName,
        PublicKeySecretName: props.publicKeySecretName,
      },
    });
  }
}
