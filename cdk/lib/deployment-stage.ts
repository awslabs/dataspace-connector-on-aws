// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Stage, StageProps, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";

import { SharedInfraStack } from "./shared-infra-stack";
import { ConnectorStack } from "./connector-stack";
import { BasyxStack } from "./basyx/basyx-stack";

import {
  connectorPriority,
  DeploymentConfig,
  enabledBasyx,
  resolveStateRemovalPolicy,
} from "./config/config";
import { ResolvedEdcIam } from "./portal/provision-output";

export interface DeploymentStageProps extends StageProps {
  readonly config: DeploymentConfig;
  readonly resolvedEdcIam: ResolvedEdcIam;
  readonly activeBpnls: string[];
  readonly deploymentName: string;
}

export class DeploymentStage extends Stage {
  constructor(scope: Construct, id: string, props: DeploymentStageProps) {
    super(scope, id, props);

    const { deployment, connectors } = props.config;

    const sharedInfra = new SharedInfraStack(this, "SharedInfra", {
      config: deployment,
      adminBpnls: props.activeBpnls,
      deploymentName: props.deploymentName,
    });

    const priorities = new Map<number, string>();
    const connectorStacks = new Map<string, ConnectorStack>();

    connectors.forEach((connector) => {
      // Deploy-gate: only connectors provision resolved to IDENTITY_READY have
      // an entry in the ephemeral edcIam map. Others are skipped this run.
      const edcIam = props.resolvedEdcIam[connector.connectorId];
      if (!edcIam) return;

      const priority = connectorPriority(connector.connectorId);
      const existing = priorities.get(priority);
      if (existing) {
        throw new Error(
          `Priority collision: connectors "${existing}" and "${connector.connectorId}" both hash to priority ${priority}. Rename one connector to resolve.`,
        );
      }
      priorities.set(priority, connector.connectorId);

      const stack = new ConnectorStack(
        this,
        `Connector-${connector.connectorId}`,
        {
          connector,
          deployment,
          sharedInfra,
          priority,
          edcIam,
          deploymentName: props.deploymentName,
        },
      );
      stack.addDependency(sharedInfra);
      connectorStacks.set(connector.connectorId, stack);
    });

    // A BaSyx stack needs its dtrConnector's data-plane security group, so it is
    // synthesized whenever that connector is. A running connector is synthesized
    // on every run, so enabling basyx later takes effect on the next run. Stack
    // dependencies come from the cross-stack references (VPC, cluster, SG).
    enabledBasyx(props.config).forEach(({ bpnl, entry, dtrConnectorId }) => {
      const connectorStack = connectorStacks.get(dtrConnectorId);
      if (!connectorStack) {
        console.log(
          `basyx ${bpnl}: dtrConnector ${dtrConnectorId} not deployed yet, skipping`,
        );
        return;
      }
      new BasyxStack(this, `BaSyx-${bpnl}`, {
        bpnl,
        entry,
        dtrConnectorId,
        deploymentName: props.deploymentName,
        profile: deployment.profile,
        stateRemovalPolicy: resolveStateRemovalPolicy(
          deployment,
          entry.stateRemovalPolicy,
        ),
        vpc: sharedInfra.vpc,
        cluster: sharedInfra.ecsCluster,
        dataPlaneSecurityGroup: connectorStack.dataPlane.securityGroup,
      });
    });

    Tags.of(this).add("Project", "dataspace-connector-on-aws");
    Tags.of(this).add(
      "GitRepo",
      "github.com/awslabs/dataspace-connector-on-aws",
    );
  }
}
