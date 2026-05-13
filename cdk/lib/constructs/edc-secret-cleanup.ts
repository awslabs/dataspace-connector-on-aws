// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";

/**
 * Scheduled cleanup of expired EDR secrets from AWS Secrets Manager.
 *
 * The EDC vault extension stores two secrets per transfer process:
 * 1. `edr--{transferProcessId}` — the full EDR data address with auth/refresh tokens
 * 2. `{authToken.jti}` (UUID) — the refresh token payload for the token refresh handler
 *
 * These secrets are never automatically deleted by EDC. This construct deploys a
 * Lambda that runs daily, identifies expired secrets by decoding JWT `exp` claims,
 * and force-deletes them.
 */
export class EdcSecretCleanup extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const handler = new Function(this, "Handler", {
      runtime: Runtime.NODEJS_24_X,
      handler: "index.handler",
      timeout: Duration.minutes(5),
      code: Code.fromInline(`
const {
  SecretsManagerClient,
  ListSecretsCommand,
  GetSecretValueCommand,
  DeleteSecretCommand,
} = require("@aws-sdk/client-secrets-manager");

const EXPIRY_BUFFER_SECONDS = 3600;
const EDR_PREFIX = "edr--";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function decodeJwtExp(token) {
  try {
    const payload = token.split(".")[1];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    return claims.exp || null;
  } catch {
    return null;
  }
}

function isExpired(exp) {
  return exp + EXPIRY_BUFFER_SECONDS < Math.floor(Date.now() / 1000);
}

async function getExpForEdr(sm, secretId) {
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  const edr = JSON.parse(SecretString);
  const auth = edr?.properties?.["https://w3id.org/edc/v0.0.1/ns/authorization"];
  if (!auth) return null;
  return decodeJwtExp(auth);
}

async function getExpForUuid(sm, secretId) {
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  const data = JSON.parse(SecretString);
  const keys = Object.keys(data).sort();
  if (keys.join(",") !== "expiresIn,refreshEndpoint,refreshToken") return null;
  return decodeJwtExp(data.refreshToken);
}

exports.handler = async () => {
  const sm = new SecretsManagerClient();
  let nextToken;
  do {
    const { SecretList, NextToken } = await sm.send(
      new ListSecretsCommand({ NextToken: nextToken, MaxResults: 100 })
    );
    nextToken = NextToken;
    for (const secret of SecretList || []) {
      const name = secret.Name;
      let exp = null;
      try {
        if (name.startsWith(EDR_PREFIX)) {
          exp = await getExpForEdr(sm, name);
        } else if (UUID_PATTERN.test(name)) {
          exp = await getExpForUuid(sm, name);
        }
        if (exp && isExpired(exp)) {
          await sm.send(new DeleteSecretCommand({
            SecretId: name,
            ForceDeleteWithoutRecovery: true,
          }));
        }
      } catch {}
    }
  } while (nextToken);
};
`),
      description: "Cleans up expired EDR token secrets from Secrets Manager",
    });

    handler.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "secretsmanager:ListSecrets",
          "secretsmanager:GetSecretValue",
          "secretsmanager:DeleteSecret",
        ],
        effect: Effect.ALLOW,
        resources: ["*"],
      }),
    );

    new Rule(this, "Schedule", {
      schedule: Schedule.cron({ hour: "3", minute: "0" }),
      targets: [new LambdaFunction(handler)],
    });
  }
}
