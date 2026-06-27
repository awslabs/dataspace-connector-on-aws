# Dataspace Connector on AWS

🚀 Deploy and manage a fleet of Dataspace Connectors for [Catena-X](https://catena-x.net/) on production-ready AWS infrastructure — from a single connector to hundreds, all managed through configuration.

To participate in secure, sovereign data sharing through the Catena-X data space, member organizations must host a [*Dataspace Connector*](https://eclipse-tractusx.github.io/docs-kits/category/connector-kit). This open-source project provides:

* Production-ready multi-connector deployment on AWS infrastructure, following AWS best practices
* GitOps-driven operations using CDK Pipelines — add or remove connectors by editing YAML files in Git
* Customization for [Tractus-X EDC](https://github.com/eclipse-tractusx/tractusx-edc), with AWS service integrations for [Amazon S3](https://aws.amazon.com/s3/), [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/), and [Amazon DynamoDB](https://aws.amazon.com/dynamodb/)
* Cost-optimized serverless infrastructure targeting <$25/month per connector at scale
* AI-assisted connector management via an included [MCP server](mcp/) and guided [Kiro Power](kiro-power/) workflows for deployment, validation, and operations

> [!IMPORTANT]
> To use this project, your organization must be onboarded to the Catena-X data space. Instructions on how to get started [can be found here](https://catena-x.net/ecosystem/onboarding/). Additionally, operating a connector in the Catena-X production environment requires your organization to pass a [conformity assessment](https://catena-x.net/ecosystem/certification/) conducted by an accredited Conformity Assessment Body (CAB). "Production-ready" in this project refers to AWS infrastructure (fault tolerance, security, observability) — not Catena-X certification status.

## Architecture

![architecture diagram](img/dataspace-connector-on-aws-architecture.png)

## Quick Start

### Prerequisites

* Java 17 (Amazon Corretto recommended)
* Docker or [Finch](https://github.com/runfinch/finch) container runtime
* Node.js 24+
* AWS CDK CLI (`npm install -g aws-cdk`)
* AWS CLI configured with credentials for your target account

### Option A: Local Deploy (Single Command)

Configure your deployment in [`cdk/lib/config/environments.ts`](cdk/lib/config/environments.ts), then:

```bash
export AWS_PROFILE=<your-profile>
export AWS_REGION=eu-central-1
./deploy-local.sh
```

This builds the EDC extensions, synthesizes CloudFormation, bootstraps the account, and deploys all stacks.

**Output:**
```
DataspaceConnectorSharedInfraStack.EdcApiManagementApiEndpoint    = https://<id>.execute-api.<region>.amazonaws.com/management/
DataspaceConnectorSharedInfraStack.EdcApiDspApiEndpoint           = https://<id>.execute-api.<region>.amazonaws.com/protocol/
DataspaceConnectorSharedInfraStack.EdcApiDataPlaneApiEndpoint     = https://<id>.execute-api.<region>.amazonaws.com/data/
DataspaceConnectorSharedInfraStack.EdcApiObservabilityApiEndpoint = https://<id>.execute-api.<region>.amazonaws.com/status/
```

After deployment, store your OAuth client secret in AWS Secrets Manager:
```bash
aws secretsmanager put-secret-value \
    --secret-id "<connectorId>/edc.iam.sts.oauth.client.secret" \
    --secret-string '<your-oauth-client-secret>' \
    --region $AWS_REGION --profile $AWS_PROFILE
```

### Option B: GitOps Deploy (CDK Pipelines)

For hands-off, Git-driven deployments — add or remove connectors by editing YAML files. See [Pipeline Deployment](#pipeline-deployment-gitops) below.

## AI-Assisted Connector Management

This project includes tooling for AI-assisted deployment and operation:

* **[MCP Server](mcp/)** — A Model Context Protocol server with 18 tools for interacting with the EDC Management API. Create assets, negotiate contracts, transfer data, and troubleshoot — all through natural language.

* **[Kiro Power](kiro-power/)** — Guided workflows for [Kiro](https://kiro.dev) that walk you through deploying your connector and validating end-to-end data exchange, including S3 loopback testing.

## Configuration

### Local Deploy (`environments.ts`)

All configuration lives in [`cdk/lib/config/environments.ts`](cdk/lib/config/environments.ts). The file exports a `DEPLOYMENT_CONFIG` object with two sections:

**`sharedInfra`** — VPC, ALB, API Gateway, ECS cluster settings:

| Field | Description |
|-------|-------------|
| `profile` | `"development"` (single NAT, Fargate Spot) or `"production"` (dual NAT, On-Demand) |
| `vpcIpAddresses` | VPC CIDR block (e.g., `"10.0.0.0/20"`) |
| `containerInsights` | Enable ECS Container Insights |
| `managementApiPrincipals` | IAM principals allowed to call the Management API |
| `observabilityApiPrincipals` | IAM principals allowed to call the Health API |
| `certificateArn` / `domainName` / `hostedZoneId` | Optional: custom domain for API endpoints |

**`connectors`** — Array of connector configurations:

| Field | Description |
|-------|-------------|
| `connectorId` | Unique ID (lowercase alphanumeric + hyphens, 2–60 chars) |
| `profile` | Optional per-connector override (`"development"` or `"production"`) |
| `controlPlaneCpu` / `controlPlaneMemoryLimitMiB` | Control Plane sizing (256 CPU / 1024 MB recommended) |
| `dataPlaneCpu` / `dataPlaneMemoryLimitMiB` | Data Plane sizing (256 CPU / 512 MB recommended) |
| `stateMachineIterationMillis` | EDC state machine polling interval in ms |
| `edcStateRemovalPolicy` | `RemovalPolicy.DESTROY` (dev) or `RemovalPolicy.RETAIN` (prod) |
| `edcIam` | Catena-X identity credentials from the Cofinity-X Portal |

### EDC Identity (`edcIam`)

These values are obtained from the [Cofinity-X Portal](https://portal.cofinity-x.com/) → "Configure Your Connector" dialog. Each connector requires its own set of credentials.

| Field | Description |
|-------|-------------|
| `TRUSTED_ISSUER` | DID of the trusted credential issuer |
| `DCP_STS_OAUTH_TOKEN_URL` | Token endpoint of the DIM instance |
| `DCP_STS_OAUTH_CLIENT_ID` | Technical user client ID (one per connector) |
| `DCP_STS_DIM_URL` | Base URL of your DIM instance |
| `PARTICIPANT_ID` | Your organization's Business Partner Number (BPN) |
| `DCP_ID` | Your connector's Decentralized Identifier (DID) |
| `DID_RESOLVER` | BPN/DID Resolution Service (BDRS) URL |

### Custom Domain

When all three optional fields (`certificateArn`, `domainName`, `hostedZoneId`) are provided in `sharedInfra`, the stack creates an API Gateway custom domain with TLS 1.2, a Route 53 A record, and maps EDC APIs as base paths (`/status`, `/management`, `/protocol`, `/data`). The default `execute-api` endpoints are disabled. The ACM certificate must be in `us-east-1` regardless of stack region (API Gateway requirement for edge-optimized endpoints).

## Pipeline Deployment (GitOps)

For automated, Git-driven deployments, this project includes an optional CDK Pipelines stack. When enabled:

1. A CodeCommit configuration repository is created automatically (or you connect your own GitHub repo)
2. To deploy a new connector, add a YAML file describing it — the pipeline picks up the change and provisions the infrastructure
3. To decommission a connector, delete its YAML file — the pipeline detects the removal and tears down the corresponding stack
4. To upgrade the connector software version, update the `appVersion` field in `pipeline.yaml` — the pipeline rebuilds and redeploys all connectors with the new version

### Setup

**1. Deploy the pipeline stack:**

```bash
export AWS_PROFILE=<your-profile>
export AWS_REGION=eu-central-1
./deploy-pipeline.sh
```

This creates a CodeCommit repository called `dataspace-connector-config` pre-populated with template YAML files.

**2. Clone the config repo:**

```bash
git clone codecommit::eu-central-1://<your-profile>@dataspace-connector-config
```

**3. Edit the YAML files** with your configuration (see schema below).

**4. Commit and push** to trigger the first pipeline deployment:

```bash
git add -A && git commit -m "Initial configuration" && git push origin main
```

After this, all subsequent changes flow through Git pushes to the config repository.

### Config Repository Structure

```
your-config-repo/
├── pipeline.yaml              # Pipeline settings
├── deployment.yaml            # Shared infrastructure config
└── connectors/
    ├── connector-alpha.yaml   # One file per connector
    ├── connector-bravo.yaml
    └── connector-charlie.yaml
```

### `pipeline.yaml`

```yaml
appRepo: awslabs/dataspace-connector-on-aws   # App source (public GitHub)
appVersion: 2.0.0                             # Git tag, branch, or commit hash
configSource: codecommit                      # "codecommit" (auto-created) or "github"
configRepoName: dataspace-connector-config    # Repository name
# connectionArn: "arn:aws:codestar-connections:..."  # Required for GitHub
requireApproval: false                        # Optional manual gate before deploy
```

### `deployment.yaml`

```yaml
profile: development
vpcIpAddresses: "10.0.0.0/20"
containerInsights: true
managementApiPrincipals:
  - "arn:aws:iam::<account-id>:role/<role-name>"
observabilityApiPrincipals:
  - "arn:aws:iam::<account-id>:role/<role-name>"
```

### `connectors/connector-<id>.yaml`

```yaml
connectorId: alpha
profile: production                     # Optional override
controlPlaneCpu: 256
controlPlaneMemoryLimitMiB: 1024
dataPlaneCpu: 256
dataPlaneMemoryLimitMiB: 512
stateMachineIterationMillis: "10000"
edcStateRemovalPolicy: DESTROY          # DESTROY or RETAIN
edcIam:
  trustedIssuer: "did:web:..."
  stsOauthTokenUrl: "https://..."
  stsOauthClientId: "..."
  stsDimUrl: "https://..."
  participantId: "BPNL..."
  dcpId: "did:web:..."
  didResolver: "https://..."
```

### Adding a Connector

1. Create `connectors/connector-<id>.yaml` with your connector's credentials
2. Commit and push to the config repo
3. The pipeline automatically deploys a new connector stack
4. **One-time manual step:** After the first deployment completes, store your OAuth client secret:
   ```bash
   aws secretsmanager put-secret-value \
       --secret-id "<connectorId>/edc.iam.sts.oauth.client.secret" \
       --secret-string '<your-oauth-client-secret>' \
       --region <region>
   ```
   This is only required once per connector. Subsequent pipeline runs do not overwrite the secret value.

### Removing a Connector

1. Delete `connectors/connector-<id>.yaml`
2. Commit and push
3. The pipeline's cleanup step automatically destroys the orphaned stack

> [!NOTE]
> If the connector was configured with `edcStateRemovalPolicy: RETAIN`, the DynamoDB table and S3 bucket will **not** be deleted when the stack is destroyed — they are retained as orphaned resources for data preservation. You must delete them manually via the AWS console or CLI if they are no longer needed.

### Teardown

To completely remove all deployed resources, follow these steps in order:

**1. Remove all connector YAML files** from the config repo and push. This triggers the pipeline's cleanup step, which destroys all connector stacks.

**2. Delete the shared infrastructure stack:**

```bash
aws cloudformation delete-stack --stack-name Deploy-DataspaceConnectorSharedInfraStack --region <region>
```

**3. Delete the pipeline stack** (removes the pipeline and CodeCommit repo):

```bash
aws cloudformation delete-stack --stack-name DataspaceConnectorPipelineStack --region <region>
```

## Deployment Profiles

| Setting | `development` | `production` |
|---------|--------------|--------------|
| VPC | 2 AZs, 1 NAT Gateway | 2 AZs, 2 NAT Gateways (HA) |
| Fargate | Spot (70% cheaper) | On-Demand |
| Log retention | 7 days | 30 days |

### Estimated Monthly Cost (eu-central-1)

| Connectors | `development` | `production` |
|-----------|---------------|--------------|
| 1 | ~$50/month | ~$80/month |
| 10 | ~$10/connector | ~$15/connector |
| 100 | ~$7/connector | ~$12/connector |

Baseline infrastructure cost drops significantly at scale because VPC, NAT Gateway, and ALB are shared. Per-connector cost is primarily Fargate compute + DynamoDB on-demand.

## Considerations

* **API Gateway payload limit:** 10 MB per request (REST API). Does not affect Consumer Pull scenarios or S3-backed data transfers.
* **Fargate Spot availability:** In `development` profile, Spot capacity constraints may cause deployment delays during updates. Retry or use `production` profile for guaranteed placement.
* **Connector ID constraints:** Must be 2–60 characters, lowercase alphanumeric + hyphens, cannot start/end with a hyphen. Used in ALB paths, DynamoDB table names, Secrets Manager prefixes, and CloudFormation stack names.

## Learn More

* [Minimum Viable Dataspace on AWS](https://github.com/aws-samples/minimum-viable-dataspace-for-catenax)
* [AWS-specific service integrations for EDC](https://github.com/eclipse-edc/Technology-Aws)
* [AWS joins Catena-X](https://aws.amazon.com/blogs/industries/aws-joins-catena-x/)
* [Rapidly experimenting with Catena-X data space technology on AWS](https://aws.amazon.com/blogs/industries/rapidly-experimenting-with-catena-x-data-space-technology-on-aws/)
* [Eclipse Tractus-X EDC](https://github.com/eclipse-tractusx/tractusx-edc)

## EDC Extensions and Service Options

The EDC connector consists of two main components: a **Control Plane** that manages data sharing agreements and policies, and a **Data Plane** that handles the actual data transfer. This deployment leverages AWS serverless services to minimize operational overhead while maintaining full EDC functionality.

### Control Plane

| Capability | This Deployment | Alternatives |
|-----------|----------------|--------------|
| Secrets Management | [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/) | Vault (self-managed) |
| Database | [Amazon DynamoDB](https://aws.amazon.com/dynamodb/) (single-table design) | [Amazon Aurora PostgreSQL](https://aws.amazon.com/rds/aurora/), PostgreSQL (self-managed) |

### Data Plane

| Capability | This Deployment | Alternatives |
|-----------|----------------|--------------|
| Secrets Management | AWS Secrets Manager | Vault (self-managed) |
| Data Transfer | [Amazon S3](https://aws.amazon.com/s3/), HTTP/HTTPS | DynamoDB, custom backends |

## Backlog / Ideas 💡

* Deployment of Digital Twin Registry (DTR) or entire [Tractus-X Hausanschluss](https://github.com/eclipse-tractusx/tractus-x-umbrella/blob/main/docs/user/common/guides/hausanschluss-bundles.md)
* Configurable switch between DynamoDB and Aurora PostgreSQL for control plane persistence
* Include examples for EDC assets, such as OAuth 2.0 and S3
* Configurable control and data plane auto-scaling on ECS Service level
* Data plane extension to serve DynamoDB data as EDC asset
* Scale-to-zero for idle consumer-only connectors

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This project is licensed under the Apache-2.0 License.
