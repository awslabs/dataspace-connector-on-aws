// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from "constructs";
import { ApiGatewayDomain } from "aws-cdk-lib/aws-route53-targets";
import { ARecord, IHostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { LogGroup } from "aws-cdk-lib/aws-logs";

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
  RequestValidator,
  SecurityPolicy,
  SpecRestApi,
} from "aws-cdk-lib/aws-apigateway";

import {
  applyApiGatewayWorkaround,
  getApiDefinitionTransform,
} from "../util/api-util";

import {
  ControlPlanePortMapping,
  DataPlanePortMapping,
} from "../config/port-mappings";

export interface EdcApiProps {
  readonly certificate?: ICertificate;
  readonly controlPlanePortMapping: ControlPlanePortMapping;
  readonly dataPlanePortMapping: DataPlanePortMapping;
  readonly hostedZone?: IHostedZone;
  readonly loadBalancerAddress: string;
  readonly managementApiPrincipals: IPrincipal[];
  readonly observabilityApiPrincipals: IPrincipal[];
  readonly vpcLinkId: string;
}

export interface EdcApiOutputs {
  readonly dataPlaneUrl: string;
  readonly dspUrl: string;
}

export class EdcApi extends Construct {
  readonly outputs: EdcApiOutputs;

  constructor(scope: Construct, id: string, props: EdcApiProps) {
    super(scope, id);

    let managementApiPolicy;
    if (props.managementApiPrincipals.length > 0) {
      managementApiPolicy = new PolicyDocument({
        statements: [
          new PolicyStatement({
            actions: ["execute-api:Invoke"],
            effect: Effect.ALLOW,
            principals: props.managementApiPrincipals,
            resources: ["arn:aws:execute-api:*"],
          }),
        ],
      });
    }

    let observabilityApiPolicy;
    if (props.observabilityApiPrincipals.length > 0) {
      observabilityApiPolicy = new PolicyDocument({
        statements: [
          new PolicyStatement({
            actions: ["execute-api:Invoke"],
            effect: Effect.ALLOW,
            principals: props.observabilityApiPrincipals,
            resources: ["arn:aws:execute-api:*"],
          }),
        ],
      });
    }

    if (props.hostedZone && !props.certificate) {
      throw new Error("Certificate is required when hostedZone is provided");
    }

    let domainName;
    if (props.hostedZone && props.certificate) {
      domainName = new DomainName(this, "DomainName", {
        certificate: props.certificate,
        domainName: props.hostedZone.zoneName,
        endpointType: EndpointType.EDGE,
        securityPolicy: SecurityPolicy.TLS_1_2,
      });

      new ARecord(this, "AliasRecord", {
        target: RecordTarget.fromAlias(new ApiGatewayDomain(domainName)),
        zone: props.hostedZone,
      });
    }

    const throttlingBurstLimit = 5;
    const throttlingRateLimit = 10;
    const commonDeployOptions = {
      dataTraceEnabled: true,
      loggingLevel: MethodLoggingLevel.INFO,
      metricsEnabled: true,
      throttlingBurstLimit: throttlingBurstLimit,
      throttlingRateLimit: throttlingRateLimit,
    };

    const observabilityAddress = `${props.loadBalancerAddress}:${props.controlPlanePortMapping.default}`;
    const observabilityApiPath = "status";
    const observabilityApiSpec = "./api/observability-api.yaml";
    const observabilityApi = new SpecRestApi(this, "ObservabilityApi", {
      apiDefinition: getApiDefinitionTransform(
        observabilityApiSpec,
        observabilityAddress,
        props.vpcLinkId,
      ),
      deployOptions: {
        ...commonDeployOptions,
        accessLogDestination: new LogGroupLogDestination(
          new LogGroup(this, "ObservabilityApiLogGroup"),
        ),
        stageName: observabilityApiPath,
      },
      disableExecuteApiEndpoint: !!props.hostedZone,
      policy: observabilityApiPolicy,
    });

    new RequestValidator(this, "ObservabilityApiValidator", {
      restApi: observabilityApi,
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    const managementAddress = `${props.loadBalancerAddress}:${props.controlPlanePortMapping.management}`;
    const managementApiPath = "management";
    const managementApiSpec = "./api/management-api.yaml";
    const managementApi = new SpecRestApi(this, "ManagementApi", {
      apiDefinition: getApiDefinitionTransform(
        managementApiSpec,
        managementAddress,
        props.vpcLinkId,
      ),
      deployOptions: {
        ...commonDeployOptions,
        accessLogDestination: new LogGroupLogDestination(
          new LogGroup(this, "ManagementApiLogGroup"),
        ),
        stageName: managementApiPath,
      },
      disableExecuteApiEndpoint: !!props.hostedZone,
      policy: managementApiPolicy,
    });

    new RequestValidator(this, "ManagementApiValidator", {
      restApi: managementApi,
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    const dspAddress = `${props.loadBalancerAddress}:${props.controlPlanePortMapping.protocol}`;
    const dspApiPath = "dsp";
    const dspApiSpec = "./api/dsp-api.yaml";
    const dspApi = new SpecRestApi(this, "DspApi", {
      apiDefinition: getApiDefinitionTransform(
        dspApiSpec,
        dspAddress,
        props.vpcLinkId,
      ),
      deployOptions: {
        ...commonDeployOptions,
        accessLogDestination: new LogGroupLogDestination(
          new LogGroup(this, "DspApiLogGroup"),
        ),
        stageName: dspApiPath,
      },
      disableExecuteApiEndpoint: !!props.hostedZone,
    });

    new RequestValidator(this, "DspApiValidator", {
      restApi: dspApi,
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    const dataPlaneAddress = `${props.loadBalancerAddress}:${props.dataPlanePortMapping.public}`;
    const dataPlaneApiPath = "data";
    const dataPlaneApiSpec = "./api/data-plane-api.yaml";
    const dataPlaneApi = new SpecRestApi(this, "DataPlaneApi", {
      apiDefinition: getApiDefinitionTransform(
        dataPlaneApiSpec,
        dataPlaneAddress,
        props.vpcLinkId,
      ),
      deployOptions: {
        ...commonDeployOptions,
        accessLogDestination: new LogGroupLogDestination(
          new LogGroup(this, "DataPlaneApiLogGroup"),
        ),
        stageName: dataPlaneApiPath,
      },
      disableExecuteApiEndpoint: !!props.hostedZone,
    });

    new RequestValidator(this, "DataPlaneApiValidator", {
      restApi: dataPlaneApi,
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    if (domainName) {
      domainName.addBasePathMapping(observabilityApi, {
        basePath: observabilityApiPath,
      });
      domainName.addBasePathMapping(managementApi, {
        basePath: managementApiPath,
      });
      domainName.addBasePathMapping(dspApi, { basePath: dspApiPath });
      domainName.addBasePathMapping(dataPlaneApi, {
        basePath: dataPlaneApiPath,
      });
    }

    const apis = [observabilityApi, managementApi, dspApi, dataPlaneApi];
    applyApiGatewayWorkaround(apis);

    if (domainName) {
      this.outputs = {
        dataPlaneUrl: `https://${domainName.domainName}/${dataPlaneApiPath}`,
        dspUrl: `https://${domainName.domainName}/${dspApiPath}`,
      };
    } else {
      this.outputs = {
        dataPlaneUrl: dataPlaneApi.url,
        dspUrl: dspApi.url,
      };
    }
  }
}
