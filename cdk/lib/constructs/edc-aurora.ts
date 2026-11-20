// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from "constructs";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import {
  CfnSecurityGroupIngress,
  ISecurityGroup,
  IVpc,
  SecurityGroup,
  SubnetType,
} from "aws-cdk-lib/aws-ec2";
import {
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
  DatabaseSecret,
} from "aws-cdk-lib/aws-rds";

import { AURORA_POSTGRES_VERSION } from "../basyx/versions";
import { DeploymentProfile } from "../config/config";

const POSTGRES_PORT = 5432;
const DATABASE_NAME = "edc";

export interface EdcAuroraProps {
  readonly vpc: IVpc;
  readonly profile: DeploymentProfile;
  readonly removalPolicy: RemovalPolicy;
  readonly clusterIdentifier: string;
}

/**
 * One Aurora Serverless v2 PostgreSQL cluster per connector, the store of
 * both EDC planes when the connector's persistence is "postgres". Mirrors the
 * Aurora cluster of the BaSyx stack.
 */
export class EdcAurora extends Construct {
  readonly cluster: DatabaseCluster;
  /** Holds the `username` and `password` the runtimes receive as ECS secrets. */
  readonly secret: DatabaseSecret;
  /** The cluster's security group; admit the runtimes with `allowFrom`. */
  readonly securityGroup: SecurityGroup;
  /**
   * Aurora PostgreSQL 17 and newer force TLS (rds.force_ssl=1). The two
   * timeouts let the first connection wait out a resume from auto-pause, which
   * takes longer than the driver defaults (10 s connect, 5 s SSL response).
   */
  readonly jdbcUrl: string;

  constructor(scope: Construct, id: string, props: EdcAuroraProps) {
    super(scope, id);
    const production = props.profile === "production";

    this.securityGroup = new SecurityGroup(this, "SecurityGroup", {
      allowAllOutbound: false,
      description: `EDC Aurora cluster ${props.clusterIdentifier}`,
      vpc: props.vpc,
    });

    this.secret = new DatabaseSecret(this, "Secret", { username: "edc" });

    this.cluster = new DatabaseCluster(this, "Cluster", {
      engine: DatabaseClusterEngine.auroraPostgres({
        version: AURORA_POSTGRES_VERSION,
      }),
      clusterIdentifier: props.clusterIdentifier,
      credentials: Credentials.fromSecret(this.secret),
      defaultDatabaseName: DATABASE_NAME,
      writer: ClusterInstance.serverlessV2("Writer"),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: production ? 8 : 4,
      serverlessV2AutoPauseDuration: Duration.seconds(300),
      storageEncrypted: true,
      backup: { retention: Duration.days(production ? 7 : 1) },
      securityGroups: [this.securityGroup],
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      // RETAIN keeps the data as a final snapshot, so removing the connector
      // leaves no cluster, security group or identifier behind.
      removalPolicy:
        props.removalPolicy === RemovalPolicy.RETAIN
          ? RemovalPolicy.SNAPSHOT
          : props.removalPolicy,
    });

    this.jdbcUrl = `jdbc:postgresql://${this.cluster.clusterEndpoint.hostname}:${POSTGRES_PORT}/${DATABASE_NAME}?sslmode=require&connectTimeout=30&sslResponseTimeout=30000`;
  }

  /**
   * Admits the tasks of `source` on the PostgreSQL port. Returns the rule so
   * that a service can wait for it. The rule is a plain resource instead of
   * SecurityGroup.addIngressRule's: the stack makes the services depend on
   * `cluster` and these rules individually, because a dependency on this whole
   * construct would make one plane's service wait for the other plane's rule,
   * which waits for that plane's security group and so for the first service.
   */
  allowFrom(
    id: string,
    source: ISecurityGroup,
    description: string,
  ): CfnSecurityGroupIngress {
    return new CfnSecurityGroupIngress(this, id, {
      description,
      fromPort: POSTGRES_PORT,
      groupId: this.securityGroup.securityGroupId,
      ipProtocol: "tcp",
      sourceSecurityGroupId: source.securityGroupId,
      toPort: POSTGRES_PORT,
    });
  }
}
