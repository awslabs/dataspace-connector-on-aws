# Dataspace Connector on AWS

🚀 Deploy a production-ready Dataspace Connector for [Catena-X](https://catena-x.net/) on AWS with a single command.

To participate in secure, sovereign data sharing through the Catena-X data space, member organizations must host a [*Dataspace Connector*](https://eclipse-tractusx.github.io/docs-kits/category/connector-kit). This open-source project comes with just that:

* Production-ready deployment blueprint for data space connectors on AWS, following AWS best practices and Catena-X learnings made since 2023
* Customization for [Tractus-X EDC](https://github.com/eclipse-tractusx/tractusx-edc), the mature Eclipse Dataspace Components (EDC) connector implementation of the Eclipse Tractus-X project, to leverage available AWS service integrations with [Amazon S3](https://aws.amazon.com/s3/) and [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/)
* EDC extension for [Amazon DynamoDB](https://aws.amazon.com/dynamodb/) as alternative to a PostgreSQL-compatible database for control plane persistance

The goal is to provide easy access to production-ready connector deployments within minutes, that leverage security, reliability and scale of the AWS Cloud in a cost-efficient manner.

## Quick Start

**Prerequisites:** `corretto@17`, `docker`, `cdk`, `npm` and `node@24`

Configure your deployment in [`cdk/lib/config/environments.ts`](cdk/lib/config/environments.ts) — see [Configuration](#configuration) for all available options.

> [!IMPORTANT]
> To use this open-source project, your company or organization must be onboarded to the Catena-X data space. Instructions on how to get started with your Catena-X journey [can be found here](https://catena-x.net/ecosystem/onboarding/).

```bash
~ ./deploy.sh

...
Outputs:
DataspaceConnectorStack.EdcApiDataPlaneApiEndpoint     = https://<api-id>.execute-api.<aws-region>.amazonaws.com/data/
DataspaceConnectorStack.EdcApiDspApiEndpoint           = https://<api-id>.execute-api.<aws-region>.amazonaws.com/protocol/
DataspaceConnectorStack.EdcApiManagementApiEndpoint    = https://<api-id>.execute-api.<aws-region>.amazonaws.com/management/
DataspaceConnectorStack.EdcApiObservabilityApiEndpoint = https://<api-id>.execute-api.<aws-region>.amazonaws.com/status/
DataspaceConnectorStack.EdcOauthClientSecretArn        = arn:aws:secretsmanager:<aws-region>:<account-id>:secret:edc.iam.sts.oauth.client.secret
```

After deployment, navigate to the [AWS Secrets Manager console](https://console.aws.amazon.com/secretsmanager/listsecrets) and update `EdcOauthClientSecretArn`'s value with your OAuth client secret obtained from the Cofinity-X Portal.

✨ That's it! You can now interact with your EDC's management API to start creating contract offers or browse a data space participant's catalog. 

## AI-Assisted Connector Management

This project includes tooling for AI-assisted deployment and operation of your connector:

* **[MCP Server](mcp/)** — A Model Context Protocol server with 15 tools for interacting with the EDC Management API. Create assets, negotiate contracts, transfer data, and troubleshoot issues — all through natural language in any MCP-compatible AI assistant.

* **[Kiro Power](kiro-power/)** — Guided workflows for [Kiro](https://kiro.dev) that walk you through deploying your connector from scratch and validating end-to-end data exchange. Includes step-by-step steering files for deployment configuration, MCP setup, and S3 loopback testing.

## Deployment Profiles

The stack supports two deployment profiles via the `profile` setting in [`environments.ts`](cdk/lib/config/environments.ts):

| Setting | `development` | `production` |
|---------|--------------|--------------|
| VPC Availability Zones | 1 (single NAT Gateway, single EIP) | 2 (HA with 2 NAT Gateways, 2 EIPs) |
| Fargate capacity | Spot (70% cheaper, 2-min interruption warning) | On-Demand |
| Container Insights | Disabled | Enabled |
| Log retention | 7 days | 30 days |

### Estimated Monthly Cost (eu-central-1, idle connector)

| Resource | `production` | `development` |
|----------|-------------|---------------|
| Fargate (Control + Data Plane) | ~$23 | ~$7 (Spot) |
| NAT Gateway | ~$76 (×2) | ~$38 (×1) |
| Elastic IP | ~$7 (×2) | ~$4 (×1) |
| Network Load Balancer | ~$19 | ~$19 |
| Other (DynamoDB, API GW, S3, Secrets, Logs) | ~$1 | ~$1 |
| **Total** | **~$125/month** | **~$68/month** |

These are rough estimates for a single idle connector in eu-central-1. Actual costs depend on data transfer volume, API request frequency, and Spot pricing fluctuations. See [AWS Pricing Calculator](https://calculator.aws/) for detailed estimates.

The `development` profile is recommended for testing, development, and non-critical workloads. Use `production` for connectors that serve data to third-party consumers and require high availability.

Setting `architecture: "arm64"` additionally reduces Fargate compute cost by ~20% (Graviton processors). This is independent of profile and stacks with Spot.

## Architecture

![architecture diagram](img/dataspace-connector-on-aws-architecture.png)

## Learn More

* [Minimum Viable Dataspace on AWS](https://github.com/aws-samples/minimum-viable-dataspace-for-catenax)
* [AWS-specific service integrations for EDC](https://github.com/eclipse-edc/Technology-Aws)
* [AWS joins Catena-X, underscoring commitment to transparency and collaboration in the global Automotive and Manufacturing Industries](https://aws.amazon.com/blogs/industries/aws-joins-catena-x/)
* [Rapidly experimenting with Catena-X data space technology on AWS](https://aws.amazon.com/blogs/industries/rapidly-experimenting-with-catena-x-data-space-technology-on-aws/)

## Configuration

All configuration is in [`cdk/lib/config/environments.ts`](cdk/lib/config/environments.ts). The file exports two objects: `edcIam` (Catena-X identity) and `DataspaceConnectorStackConfig` (AWS infrastructure).

### EDC Identity Configuration (`edcIam`)

These values are obtained from the [Cofinity-X Portal](https://portal.beta.cofinity-x.com/) after onboarding your organization to the Catena-X data space. The field names match the portal's "Configure Your Connector" dialog — copy-paste values directly.

| Field | Portal Label | Description |
|-------|-------------|-------------|
| `TRUSTED_ISSUER` | trusted_issuer | DID of the trusted credential issuer (the Catena-X operator) |
| `DCP_STS_OAUTH_TOKEN_URL` | dcp.sts.oauth.token_url | Token endpoint of the Decentralized Identity Management (DIM) instance |
| `DCP_STS_OAUTH_CLIENT_ID` | dcp.sts.oauth.client.id | Technical user client ID for the specific connector (one per connector) |
| `DCP_STS_DIM_URL` | dcp.sts.dim.url | Base URL of your Decentralized Identity Management instance |
| `PARTICIPANT_ID` | participant_id | Your organization's Business Partner Number (BPN) |
| `DCP_ID` | dcp.id | Your connector's Decentralized Identifier (DID) |
| `DID_RESOLVER` | DID Resolver | BPN/DID Resolution Service (BDRS) URL for resolving participant identities |

> [!NOTE]
> The OAuth client secret (`dcp.sts.oauth.client.secret_alias` in the portal) is stored in AWS Secrets Manager, not in code. After deployment, update the secret `edc.iam.sts.oauth.client.secret` via the AWS console.

### Infrastructure Configuration (`DataspaceConnectorStackConfig`)

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `profile` | Yes | — | Deployment profile: `"development"` (single AZ, Spot, lower cost) or `"production"` (multi-AZ, On-Demand, HA). See [Deployment Profiles](#deployment-profiles). |
| `architecture` | No | `"x86_64"` | CPU architecture: `"x86_64"` or `"arm64"` (Graviton, ~20% cheaper). |
| `controlPlaneCpu` | Yes | — | CPU units for the Control Plane task (256 = 0.25 vCPU) |
| `controlPlaneMemoryLimitMiB` | Yes | — | Memory in MiB for the Control Plane task (1024 recommended) |
| `stateMachineIterationMillis` | Yes | `"60000"` | Polling interval for all EDC state machine processors (ms). Lower values detect state changes faster but increase DynamoDB reads. |
| `controlPlanePortMapping` | Yes | — | Port mapping for the Control Plane. Use `CONTROL_PLANE_PORT_MAPPING_DEFAULT`. |
| `dataPlaneCpu` | Yes | — | CPU units for the Data Plane task (256 = 0.25 vCPU) |
| `dataPlaneMemoryLimitMiB` | Yes | — | Memory in MiB for the Data Plane task (512 recommended) |
| `dataPlanePortMapping` | Yes | — | Port mapping for the Data Plane. Use `DATA_PLANE_PORT_MAPPING_DEFAULT`. |
| `edcIam` | Yes | — | EDC identity configuration object (see table above) |
| `edcStateRemovalPolicy` | Yes | — | CloudFormation removal policy for DynamoDB tables and S3. Use `RemovalPolicy.DESTROY` for dev, `RemovalPolicy.RETAIN` for prod. |
| `managementApiAuthKey` | Yes | — | EDC-level API key for the Management API. Set to `""` if relying on IAM auth alone. |
| `managementApiPrincipals` | Yes | — | IAM principals allowed to call the Management API (array of `ArnPrincipal`). |
| `observabilityApiPrincipals` | Yes | — | IAM principals allowed to call the Observability/Health API. |
| `vpcIpAddresses` | Yes | — | CIDR block for the VPC (e.g., `"10.0.10.0/24"`). |
| `certificateArn` | No | — | ACM certificate ARN in `us-east-1` for custom domain. Requires `domainName` and `hostedZoneId`. |
| `domainName` | No | — | Custom domain for EDC APIs (e.g., `"edc.example.com"`). |
| `hostedZoneId` | No | — | Route 53 hosted zone ID for the custom domain. |

### Custom Domain

When all three optional fields (`certificateArn`, `domainName`, `hostedZoneId`) are provided, the stack creates an API Gateway custom domain with TLS 1.2, a Route 53 A record, and maps EDC APIs as base paths (`/status`, `/management`, `/protocol`, `/data`). The default `execute-api` endpoints are disabled. The ACM certificate must be in `us-east-1` regardless of stack region (API Gateway requirement for edge-optimized endpoints).

## Considerations

The maximum payload size for [Amazon API Gateway](https://aws.amazon.com/api-gateway/) REST APIs is 10 MB (see [service quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html)). This means a single EDC data transfer can't exceed 10 MB when data is pushed to the EDC's data plane API behind API Gateway.

This does not apply to [*Consumer Pull*](https://eclipse-edc.github.io/documentation/for-adopters/control-plane/#flow-types) scenarios. A potential mitigation is to store larger objects on Amazon S3, using [presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html) to only push a temporary link to requested data to a consumer.

## EDC Extensions and Service Options

The EDC connector consists of two main components: a **Control Plane** that manages data sharing agreements and policies, and a **Data Plane** that handles the actual data transfer. By default, EDC requires you to deploy and manage supporting infrastructure like databases and secret stores yourself. AWS offers managed alternatives that reduce operational complexity and provide enterprise-grade security and reliability out of the box.

This deployment leverages AWS serverless services where possible, to minimize operational heavy-lifting while maintaining EDC's full functionality.

### Control Plane

**Secrets Management:**
Stores private keys, certificates, and API credentials for secure communication and data plane authentication.
* **[AWS Secrets Manager](https://aws.amazon.com/secrets-manager/)** (used in this deployment) - Fully managed secrets management service
* **Vault** (self-managed alternative) - Requires separate deployment and maintenance

**Database:**
Stores contract negotiations, agreements, policies, transfer processes, and asset metadata.
* **[Amazon DynamoDB](https://aws.amazon.com/dynamodb/)** (used in this deployment) - Serverless NoSQL database with pay-per-request pricing
* **[Amazon Aurora PostgreSQL](https://aws.amazon.com/rds/aurora/)** (managed alternative) - Fully managed relational database for PostgreSQL
* **PostgreSQL** (self-managed alternative) - Requires separate deployment and maintenance

### Data Plane

**Secrets Management:**
Stores credentials needed to access data sources and destinations during transfer operations.
* **AWS Secrets Manager** (used in this deployment)
* **Vault** (self-managed alternative)

**Data Transfer:**
* **[Amazon S3](https://aws.amazon.com/s3/)** - Object storage with presigned URL support
* **Amazon DynamoDB** - NoSQL database as data source/destination
* **HTTP/HTTPS** (default EDC protocol) - Direct data transfer via HTTP endpoints

## Backlog / Ideas 💡

* Configurable switch between DynamoDB and Aurora PostgreSQL for control plane persistance
* Include examples for EDC assets, such as OAuth 2.0 and S3
* Configurable control and data plane auto-scaling on ECS Service level
* Create data plane extension to serve DynamoDB data as EDC asset
* Allow for deployment of Digital Twin Registry (DTR) or entire [Tractus-X Hausanschluss](https://github.com/eclipse-tractusx/tractus-x-umbrella/blob/main/docs/user/common/guides/hausanschluss-bundles.md)

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This project is licensed under the Apache-2.0 License.
