// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from "constructs";
import { ApiGatewayDomain } from "aws-cdk-lib/aws-route53-targets";
import { ARecord, IHostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  Effect,
  IPrincipal,
  PolicyDocument,
  PolicyStatement,
} from "aws-cdk-lib/aws-iam";
import {
  DomainName,
  EndpointType,
  LogGroupLogDestination,
  MethodLoggingLevel,
  SecurityPolicy,
  SpecRestApi,
} from "aws-cdk-lib/aws-apigateway";

import { apiDefinition } from "../util/api-util";
import { CONTROL_PLANE_PORTS, DATA_PLANE_PORTS } from "../config/port-mappings";
import { DeploymentProfile } from "../config/config";

export interface EdcApiProps {
  readonly albArn: string;
  readonly loadBalancerAddress: string;
  readonly vpcLinkId: string;
  /** Custom domain; without it each API keeps its execute-api endpoint. */
  readonly domain?: {
    readonly certificate: ICertificate;
    readonly hostedZone: IHostedZone;
  };
  readonly managementApiPrincipals: IPrincipal[];
  readonly observabilityApiPrincipals: IPrincipal[];
  readonly profile: DeploymentProfile;
  /** Log full request and response bodies; they include EDR and BaSyx tokens. */
  readonly dataTrace: boolean;
}

/** The four REST APIs in front of the connectors, one stage (base path) each. */
export class EdcApi extends Construct {
  readonly dataPlaneUrl: string;
  readonly dspUrl: string;
  readonly managementUrl: string;

  constructor(scope: Construct, id: string, props: EdcApiProps) {
    super(scope, id);

    const invokePolicy = (principals: IPrincipal[]) =>
      principals.length === 0
        ? undefined
        : new PolicyDocument({
            statements: [
              new PolicyStatement({
                actions: ["execute-api:Invoke"],
                effect: Effect.ALLOW,
                principals,
                resources: ["arn:aws:execute-api:*"],
              }),
            ],
          });

    const definitions = [
      {
        name: "ObservabilityApi",
        spec: "observability-api.yaml",
        port: CONTROL_PLANE_PORTS.default,
        stage: "status",
        policy: invokePolicy(props.observabilityApiPrincipals),
      },
      {
        name: "ManagementApi",
        spec: "management-api.yaml",
        port: CONTROL_PLANE_PORTS.management,
        stage: "management",
        policy: invokePolicy(props.managementApiPrincipals),
      },
      {
        name: "DspApi",
        spec: "dsp-api.yaml",
        port: CONTROL_PLANE_PORTS.protocol,
        stage: "protocol",
      },
      {
        name: "DataPlaneApi",
        spec: "data-plane-api.yaml",
        port: DATA_PLANE_PORTS.public,
        stage: "data",
      },
    ];

    const domainName =
      props.domain &&
      new DomainName(this, "DomainName", {
        certificate: props.domain.certificate,
        domainName: props.domain.hostedZone.zoneName,
        endpointType: EndpointType.EDGE,
        securityPolicy: SecurityPolicy.TLS_1_2,
      });
    if (domainName) {
      new ARecord(this, "AliasRecord", {
        target: RecordTarget.fromAlias(new ApiGatewayDomain(domainName)),
        zone: props.domain!.hostedZone,
      });
    }

    const urls: Record<string, string> = {};
    let previous: SpecRestApi | undefined;
    for (const d of definitions) {
      const api = new SpecRestApi(this, d.name, {
        apiDefinition: apiDefinition(`./api/${d.spec}`, {
          loadBalancerDnsName: `${props.loadBalancerAddress}:${d.port}`,
          dataPlaneDefaultAddress: `${props.loadBalancerAddress}:${DATA_PLANE_PORTS.default}`,
          vpcLinkId: props.vpcLinkId,
          albArn: props.albArn,
        }),
        deployOptions: {
          stageName: d.stage,
          dataTraceEnabled: props.dataTrace,
          loggingLevel: MethodLoggingLevel.INFO,
          metricsEnabled: true,
          accessLogDestination: new LogGroupLogDestination(
            new LogGroup(this, `${d.name}LogGroup`, {
              retention:
                props.profile === "production"
                  ? RetentionDays.ONE_MONTH
                  : RetentionDays.ONE_WEEK,
            }),
          ),
        },
        disableExecuteApiEndpoint: !!domainName,
        policy: d.policy,
      });
      domainName?.addBasePathMapping(api, { basePath: d.stage });
      // API Gateway allows few control-plane calls per second and CloudFormation
      // does not throttle, so the APIs are created one after another.
      // https://github.com/aws-cloudformation/cloudformation-coverage-roadmap/issues/1095
      if (previous) api.node.addDependency(previous);
      previous = api;
      urls[d.stage] = domainName
        ? `https://${domainName.domainName}/${d.stage}`
        : api.url;
    }

    this.dataPlaneUrl = urls.data;
    this.dspUrl = urls.protocol;
    this.managementUrl = urls.management;
  }
}
