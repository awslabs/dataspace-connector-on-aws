// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { join } from "path";

import {
  ConnectorYaml,
  loadDeploymentConfig,
  PersistenceType,
  StateRemovalPolicy,
} from "../lib/config/config";
import { ConnectorStack } from "../lib/connector-stack";
import { DeploymentStage } from "../lib/deployment-stage";
import { SharedInfraStack } from "../lib/shared-infra-stack";

const CONFIG_PATH = join(__dirname, "..", "config-templates");
const env = { account: "111111111111", region: "eu-central-1" };
const DID =
  "did:web:portal-backend.beta.cofinity-x.com:api:administration:staticdata:did:BPNL000000000000";

interface ConnectorSpec {
  readonly id: string;
  readonly persistence: PersistenceType;
  readonly stateRemovalPolicy?: StateRemovalPolicy;
}

/** The bundled templates, with the given connectors in place of the example. */
function stage(
  specs: ConnectorSpec[],
  deploymentName = "DataspaceConnector",
): DeploymentStage {
  const loaded = loadDeploymentConfig(CONFIG_PATH);
  const connectors: ConnectorYaml[] = specs.map((spec) => ({
    ...loaded.connectors[0],
    connectorId: spec.id,
    persistence: spec.persistence,
    stateRemovalPolicy:
      spec.stateRemovalPolicy ?? loaded.connectors[0].stateRemovalPolicy,
  }));
  const host = new Stack(new App(), "Host", { env });
  return new DeploymentStage(host, "DataspaceConnector", {
    config: { deployment: loaded.deployment, connectors },
    deploymentName,
    env,
  });
}

const connectorStack = (s: DeploymentStage, id: string): ConnectorStack =>
  s.node.findChild(`Connector-${id}`) as ConnectorStack;

const sharedInfra = (s: DeploymentStage): SharedInfraStack =>
  s.node.findChild("SharedInfra") as SharedInfraStack;

type Container = {
  Name: string;
  Image: unknown;
  Environment: { Name: string; Value: unknown }[];
  Secrets?: { Name: string; ValueFrom: unknown }[];
};

/** The runtime container of each task definition, by plane. */
function containers(template: Template): Record<string, Container> {
  return Object.fromEntries(
    Object.values(template.findResources("AWS::ECS::TaskDefinition")).map(
      (r) => {
        const [container] = r.Properties.ContainerDefinitions as Container[];
        return [container.Name, container];
      },
    ),
  );
}

const environment = (container: Container): Record<string, unknown> =>
  Object.fromEntries(container.Environment.map((e) => [e.Name, e.Value]));

/** Every action granted by the task roles' inline policies. */
function grantedActions(template: Template): string[] {
  return Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (policy) =>
      policy.Properties.PolicyDocument.Statement.flatMap(
        (s: { Action: string | string[] }) => s.Action,
      ),
  );
}

const imageOf = (container: Container): string =>
  JSON.stringify(container.Image);

describe("ConnectorStack with persistence dynamodb", () => {
  const s = stage([{ id: "example", persistence: "dynamodb" }]);
  const template = Template.fromStack(connectorStack(s, "example"));
  const planes = containers(template);

  test("stores state in a DynamoDB table and creates no cluster", () => {
    template.resourceCountIs("AWS::DynamoDB::GlobalTable", 1);
    template.resourceCountIs("AWS::RDS::DBCluster", 0);
    template.resourceCountIs("AWS::RDS::DBInstance", 0);
    // The OAuth client secret only: no database credentials.
    template.resourceCountIs("AWS::SecretsManager::Secret", 1);
  });

  test("the task roles may use the table", () => {
    expect(grantedActions(template)).toEqual(
      expect.arrayContaining(["dynamodb:GetItem", "dynamodb:PutItem"]),
    );
  });

  test("both planes get the table name, and neither a datasource nor a participant context", () => {
    expect(Object.keys(planes).sort()).toEqual(["ControlPlane", "DataPlane"]);
    for (const container of Object.values(planes)) {
      const vars = environment(container);
      expect(vars["edc.ddb.table.name"]).toBeDefined();
      expect(vars).not.toHaveProperty("edc.participant.context.id");
      expect(vars).not.toHaveProperty("edc.datasource.default.url");
      expect(
        Object.keys(vars).filter((k) => k.startsWith("tx.edc.postgresql")),
      ).toEqual([]);
      expect(container.Secrets).toBeUndefined();
    }
  });

  test("runs the DynamoDB images", () => {
    const { controlPlaneImages, dataPlaneImages } = sharedInfra(s);
    expect(imageOf(planes.ControlPlane)).toContain(
      controlPlaneImages.dynamodb!.assetHash,
    );
    expect(imageOf(planes.DataPlane)).toContain(
      dataPlaneImages.dynamodb!.assetHash,
    );
  });

  test("keeps the CDK default health check grace period", () => {
    for (const service of Object.values(
      template.findResources("AWS::ECS::Service"),
    )) {
      expect(service.Properties.HealthCheckGracePeriodSeconds).toBe(60);
    }
  });

  test("exports the bucket name only", () => {
    expect(Object.keys(template.toJSON().Outputs)).toEqual([
      "EdcDataPlaneBucketName",
    ]);
  });
});

describe("ConnectorStack with persistence aurora", () => {
  const s = stage([{ id: "example", persistence: "aurora" }]);
  const template = Template.fromStack(connectorStack(s, "example"));
  const planes = containers(template);

  test("creates a Serverless v2 cluster, its credentials and no DynamoDB table", () => {
    template.resourceCountIs("AWS::DynamoDB::GlobalTable", 0);
    template.resourceCountIs("AWS::DynamoDB::Table", 0);
    template.resourceCountIs("AWS::RDS::DBCluster", 1);
    template.resourceCountIs("AWS::RDS::DBInstance", 1);
    template.hasResourceProperties("AWS::RDS::DBCluster", {
      DBClusterIdentifier: "dataspaceconnector-example",
      DatabaseName: "edc",
      Engine: "aurora-postgresql",
      StorageEncrypted: true,
      ServerlessV2ScalingConfiguration: {
        MinCapacity: 0,
        MaxCapacity: 8,
        SecondsUntilAutoPause: 300,
      },
    });
    template.hasResourceProperties("AWS::RDS::DBInstance", {
      DBInstanceClass: "db.serverless",
    });
    // The OAuth client secret and the database credentials.
    template.resourceCountIs("AWS::SecretsManager::Secret", 2);
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      GenerateSecretString: Match.objectLike({
        SecretStringTemplate: JSON.stringify({ username: "edc" }),
      }),
    });
  });

  test("the development profile scales and retains less", () => {
    const loaded = loadDeploymentConfig(CONFIG_PATH);
    const host = new Stack(new App(), "Host", { env });
    const development = new DeploymentStage(host, "DataspaceConnector", {
      config: {
        deployment: loaded.deployment,
        connectors: [
          {
            ...loaded.connectors[0],
            persistence: "aurora",
            profile: "development",
          },
        ],
      },
      deploymentName: "DataspaceConnector",
      env,
    });
    Template.fromStack(
      connectorStack(development, "example"),
    ).hasResourceProperties("AWS::RDS::DBCluster", {
      BackupRetentionPeriod: 1,
      ServerlessV2ScalingConfiguration: Match.objectLike({ MaxCapacity: 4 }),
    });
  });

  test("the task roles have no DynamoDB access", () => {
    expect(
      grantedActions(template).filter((a) => a.startsWith("dynamodb:")),
    ).toEqual([]);
  });

  test("both planes get the datasource, the participant context and the migration settings", () => {
    expect(Object.keys(planes).sort()).toEqual(["ControlPlane", "DataPlane"]);
    for (const container of Object.values(planes)) {
      const vars = environment(container);
      expect(JSON.stringify(vars["edc.datasource.default.url"])).toContain(
        ":5432/edc?sslmode=require",
      );
      expect(vars["edc.participant.context.id"]).toBe(DID);
      expect(vars["edc.participant.context.id"]).toBe(
        vars["edc.participant.id"],
      );
      expect(vars["tx.edc.postgresql.migration.enabled"]).toBe("true");
      expect(vars["tx.edc.postgresql.migration.schema"]).toBe("public");
      expect(vars).not.toHaveProperty("edc.ddb.table.name");
    }
  });

  test("the credentials reach both planes as ECS secrets, not as plain values", () => {
    const [secretId] = Object.keys(
      template.findResources("AWS::SecretsManager::Secret", {
        Properties: { GenerateSecretString: Match.anyValue() },
      }),
    );
    for (const container of Object.values(planes)) {
      expect(container.Secrets).toEqual([
        {
          Name: "EDC_DATASOURCE_DEFAULT_USER",
          ValueFrom: {
            "Fn::Join": ["", [{ Ref: secretId }, ":username::"]],
          },
        },
        {
          Name: "EDC_DATASOURCE_DEFAULT_PASSWORD",
          ValueFrom: {
            "Fn::Join": ["", [{ Ref: secretId }, ":password::"]],
          },
        },
      ]);
      const names = Object.keys(environment(container));
      expect(names).not.toContain("EDC_DATASOURCE_DEFAULT_USER");
      expect(names).not.toContain("EDC_DATASOURCE_DEFAULT_PASSWORD");
    }
  });

  test("the cluster admits the tasks of both planes on 5432 and nothing else", () => {
    const clusterSg = template.findResources("AWS::EC2::SecurityGroup", {
      Properties: { GroupDescription: Match.stringLikeRegexp("Aurora") },
    });
    const [clusterSgId] = Object.keys(clusterSg);
    // No allowed egress: CDK renders the "disallow all traffic" placeholder.
    expect(
      clusterSg[clusterSgId].Properties.SecurityGroupEgress.map(
        (e: { Description: string }) => e.Description,
      ),
    ).toEqual(["Disallow all traffic"]);

    // The first security group of each service is the plane's own.
    const taskSgIds = Object.values(template.findResources("AWS::ECS::Service"))
      .map(
        (r) =>
          r.Properties.NetworkConfiguration.AwsvpcConfiguration
            .SecurityGroups[0]["Fn::GetAtt"][0],
      )
      .sort();
    expect(taskSgIds).toHaveLength(2);

    const ingress = Object.values(
      template.findResources("AWS::EC2::SecurityGroupIngress"),
    ).map((r) => r.Properties);
    expect(ingress).toHaveLength(2);
    for (const rule of ingress) {
      expect(rule).toMatchObject({
        FromPort: 5432,
        ToPort: 5432,
        IpProtocol: "tcp",
        GroupId: { "Fn::GetAtt": [clusterSgId, "GroupId"] },
      });
    }
    expect(
      ingress.map((r) => r.SourceSecurityGroupId["Fn::GetAtt"][0]).sort(),
    ).toEqual(taskSgIds);
  });

  test("each service waits for the cluster and the rule for its own tasks only", () => {
    const [clusterId] = Object.keys(
      template.findResources("AWS::RDS::DBCluster"),
    );
    const rules = Object.entries(
      template.findResources("AWS::EC2::SecurityGroupIngress"),
    );
    const services = template.findResources("AWS::ECS::Service");
    for (const service of Object.values(services)) {
      const ownSg =
        service.Properties.NetworkConfiguration.AwsvpcConfiguration
          .SecurityGroups[0]["Fn::GetAtt"][0];
      const own = rules
        .filter(
          ([, r]) =>
            r.Properties.SourceSecurityGroupId["Fn::GetAtt"][0] === ownSg,
        )
        .map(([id]) => id);
      expect(own).toHaveLength(1);
      expect(service.DependsOn).toContain(clusterId);
      expect(service.DependsOn).toContain(own[0]);
    }
  });

  test("keeps the data plane behind the control plane, which migrates the schema first", () => {
    const services = template.findResources("AWS::ECS::Service");
    const [controlPlaneId] = Object.entries(services)
      .filter(([, r]) =>
        JSON.stringify(r).includes('"ContainerName":"ControlPlane"'),
      )
      .map(([id]) => id);
    const dataPlane = Object.values(services).find((r) =>
      JSON.stringify(r).includes('"ContainerName":"DataPlane"'),
    );
    expect(dataPlane!.DependsOn).toContain(controlPlaneId);
  });

  test("gives both services time to resume the cluster and migrate", () => {
    for (const service of Object.values(
      template.findResources("AWS::ECS::Service"),
    )) {
      expect(service.Properties.HealthCheckGracePeriodSeconds).toBe(300);
    }
  });

  test("runs the PostgreSQL images", () => {
    const { controlPlaneImages, dataPlaneImages } = sharedInfra(s);
    expect(imageOf(planes.ControlPlane)).toContain(
      controlPlaneImages.aurora!.assetHash,
    );
    expect(imageOf(planes.DataPlane)).toContain(
      dataPlaneImages.aurora!.assetHash,
    );
    expect(controlPlaneImages.dynamodb).toBeUndefined();
  });

  test("exports the cluster endpoint and the credentials secret", () => {
    expect(Object.keys(template.toJSON().Outputs).sort()).toEqual([
      "EdcAuroraClusterEndpoint",
      "EdcAuroraSecretArn",
      "EdcDataPlaneBucketName",
    ]);
  });

  test.each([
    ["RETAIN", true, "Retain"],
    ["DESTROY", false, "Delete"],
  ] as const)(
    "stateRemovalPolicy %s: deletionProtection %s, cluster, secret and security group %s",
    (stateRemovalPolicy, deletionProtection, policy) => {
      const t = Template.fromStack(
        connectorStack(
          stage([{ id: "example", persistence: "aurora", stateRemovalPolicy }]),
          "example",
        ),
      );
      t.hasResource("AWS::RDS::DBCluster", {
        Properties: { DeletionProtection: deletionProtection },
        DeletionPolicy: policy,
      });
      t.hasResource("AWS::RDS::DBInstance", { DeletionPolicy: policy });
      t.hasResource("AWS::EC2::SecurityGroup", {
        Properties: { GroupDescription: Match.stringLikeRegexp("Aurora") },
        DeletionPolicy: policy,
      });
      t.hasResource("AWS::SecretsManager::Secret", {
        Properties: { GenerateSecretString: Match.anyValue() },
        DeletionPolicy: policy,
      });
      // The ingress rules are always deleted: retained, they would keep
      // referencing the planes' security groups and block their deletion.
      const ingress = Object.values(
        t.findResources("AWS::EC2::SecurityGroupIngress"),
      );
      expect(ingress).toHaveLength(2);
      for (const rule of ingress) {
        expect(rule.DeletionPolicy).toBeUndefined();
      }
    },
  );
});

describe("Aurora cluster identifier", () => {
  // 41 + 1 + 30 = 72 characters, over the 63 RDS allows.
  const deploymentName = "A".repeat(41);
  const connectorId = "c".repeat(30);

  test("an over-long identifier fails the aurora connector", () => {
    expect(() =>
      stage([{ id: connectorId, persistence: "aurora" }], deploymentName),
    ).toThrow(/Aurora cluster identifier .* is 72 characters \(max 63\)/);
  });

  test("the same names are fine for a dynamodb connector", () => {
    expect(() =>
      stage([{ id: connectorId, persistence: "dynamodb" }], deploymentName),
    ).not.toThrow();
  });
});

describe("DeploymentStage with connectors of both persistence types", () => {
  const s = stage([
    { id: "ddb-one", persistence: "dynamodb" },
    { id: "aurora-one", persistence: "aurora" },
  ]);
  const ddb = Template.fromStack(connectorStack(s, "ddb-one"));
  const aurora = Template.fromStack(connectorStack(s, "aurora-one"));

  test("synthesizes", () => {
    expect(() => s.synth()).not.toThrow();
  });

  test("each connector gets its own store and images", () => {
    ddb.resourceCountIs("AWS::DynamoDB::GlobalTable", 1);
    ddb.resourceCountIs("AWS::RDS::DBCluster", 0);
    aurora.resourceCountIs("AWS::DynamoDB::GlobalTable", 0);
    aurora.resourceCountIs("AWS::RDS::DBCluster", 1);

    const { controlPlaneImages } = sharedInfra(s);
    expect(imageOf(containers(ddb).ControlPlane)).toContain(
      controlPlaneImages.dynamodb!.assetHash,
    );
    expect(imageOf(containers(aurora).ControlPlane)).toContain(
      controlPlaneImages.aurora!.assetHash,
    );
  });
});

describe("DeploymentStage with aurora connectors only", () => {
  test("synthesizes, with no DynamoDB image", () => {
    const s = stage([{ id: "aurora-one", persistence: "aurora" }]);
    expect(() => s.synth()).not.toThrow();
    expect(sharedInfra(s).controlPlaneImages.dynamodb).toBeUndefined();
  });
});
