# Deploying and Testing a Branch

How to deploy a branch of this repository, including one that is not merged yet, into a test account and verify that every configured persistence type works. The procedure is the normal [Quick Start](../README.md#quick-start) with a few additions for unmerged code and for `postgres` connectors.

## Prerequisites

* The [Quick Start prerequisites](../README.md#prerequisites): Node.js 24+, the AWS CLI with credentials for the test account, and a Cofinity-X Portal account on the environment you test against (`beta` is the usual choice for a test deployment).
* [`uv`](https://docs.astral.sh/uv/) for the MCP server, which drives the end-to-end test.
* A GitHub repository the pipeline can read. The pipeline clones `appRepo` at `appVersion` with no credentials, so the repository must be public. To test a branch that is not in `awslabs/dataspace-connector-on-aws`, push it to a public fork and give the setup wizard that fork as the app repository (step 2). The app repository is fixed when the pipeline is created.

You do not need Docker, Java or an ARM64 host: the pipeline's Synth step builds the jars, and its asset publishing step builds the container images.

## 1. Portal admin secret

Create the portal admin technical user and its secret as described in [Deploy the Pipeline](../README.md#deploy-the-pipeline), step 1. The secret name starts with the deployment name you choose in step 2 (the default is shown). Put the credentials in a file and pass the file, so that the secret never appears in your shell history:

```bash
aws secretsmanager create-secret --name DataspaceConnector/portal-admin/<BPNL> \
  --secret-string file://portal-admin.json
rm portal-admin.json
```

## 2. Pipeline stack

The pipeline's Synth step clones `appRepo` on every execution, using the repository URL set when the pipeline is created, so a branch that exists only in a fork must be named in the first `./deploy.sh` run. Run it from a checkout of the branch under test, with `AWS_PROFILE` and `AWS_REGION` set:

```bash
export AWS_PROFILE=<your-profile>
export AWS_REGION=eu-central-1
./deploy.sh
```

With no `./config` folder yet, the script starts its setup wizard and asks for the values that are fixed once the pipeline exists:

| Prompt | Answer for a branch test |
|---|---|
| Deployment name | The default `DataspaceConnector`, or another name if the account already hosts a deployment. The commands in this guide use the default; substitute yours. |
| App repository | `<your-github-user>/dataspace-connector-on-aws`, the public fork that holds the branch. |
| App version | The branch name, or a commit hash. The default is the exact tag or the branch you have checked out. |
| Config repository provider | `codecommit`, unless you prefer GitHub with a CodeConnections connection. |

The wizard writes `./config` (a copy of `cdk/config-templates/` with your answers in `pipeline.yaml`; Git ignores it), then bootstraps the account and deploys the `<deploymentName>PipelineStack`. The stack creates the `<deploymentName>-config` CodeCommit repository and seeds it from `./config`.

Later runs of `./deploy.sh` reuse `./config` and update the pipeline stack in place. `appVersion` is read from the config repository on every pipeline execution, so you can point the pipeline at another branch or commit of the same fork by changing it in `pipeline.yaml` and pushing. `appRepo` and `deploymentName` cannot change after the first deploy: to test a branch from another repository, use a new deployment name.

## 3. Test configuration

Clone the config repository and write a configuration that exercises every persistence type, as in the README's [Deploy the Pipeline](../README.md#deploy-the-pipeline), step 3. The seeded repository contains the placeholder BPNL and `connector-example.yaml` from the templates, so replace them. Leave `pipeline.yaml` as the wizard wrote it. A minimal two-connector test:

`deployment.yaml`

```yaml
portal:
  environment: beta
  bpnl: "<your BPNL>"
profile: development
stateRemovalPolicy: DESTROY
managementApiPrincipals:
  - "<ARN of the role you run the tests with>"
```

`connectors/connector-ddb-test.yaml`

```yaml
connectorId: ddb-test
```

`connectors/connector-postgres-test.yaml`

```yaml
connectorId: postgres-test
persistence: postgres
```

Notes:

* `stateRemovalPolicy: DESTROY` lets the teardown remove the table, the bucket and the Aurora cluster with the stacks. The default `RETAIN` leaves them behind, and a retained Aurora cluster blocks re-creating a connector with the same id (see [Persistence](../README.md#persistence)).
* `profile` in `deployment.yaml` applies to the shared infrastructure and BaSyx. A connector's own `profile` defaults to `production` regardless, which for a `postgres` connector means the larger capacity ceiling and 7 days of backups. Set `profile: development` in the connector file if you want the smaller cluster.
* `managementApiPrincipals` must include the principal that runs the test, or every Management API call returns 403.
* Delete `connectors/connector-example.yaml` from the repository, or the pipeline tries to deploy it.

Commit and push. Each push starts a pipeline execution.

If you prefer the first execution to run on your test configuration, copy `cdk/config-templates` to `./config` and edit all three files, including `appRepo` and `appVersion` in `pipeline.yaml`, before the first `./deploy.sh`. The script then skips the wizard and seeds the repository from that folder.

## 4. Watching the pipeline

```bash
aws codepipeline get-pipeline-state --name DataspaceConnectorPipeline \
  --query 'stageStates[].[stageName,latestExecution.status]' --output table
```

The Synth step's CodeBuild log shows which jars were built. A deployment with both persistence types runs `./gradlew clean shadowJar postgresShadowJar`; a DynamoDB-only deployment runs `./gradlew clean shadowJar`. If the Synth step fails, read its log: a failing Gradle build or a `cdk synth` validation error (for example an Aurora cluster identifier that breaks RDS's naming rules) surfaces here.

A first run with a new connector takes longer because the portal creates the connector's technical user. When the execution has succeeded, these stacks exist:

```bash
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query 'StackSummaries[?starts_with(StackName,`DataspaceConnector`)].[StackName,StackStatus]' --output table
```

Expect `DataspaceConnectorPipelineStack`, `DataspaceConnector-SharedInfra` and one `DataspaceConnector-Connector-<id>` stack per connector.

## 5. Checks per connector

### Both persistence types

Each connector runs two ECS services (control plane and data plane). Both log groups should contain `ready` from the runtime and no stack traces:

```bash
aws logs describe-log-groups --log-group-name-prefix DataspaceConnector-Connector-<id> \
  --query 'logGroups[].logGroupName' --output text
aws logs filter-log-events --log-group-name <log group> --filter-pattern ready --query 'events[].message'
```

### `dynamodb`

* The table `DataspaceConnector-<id>` exists.
* The data-plane log contains `Data Plane DynamoDB Extension initialization complete!`.

### `postgres`

* The cluster `dataspaceconnector-<id>` (the deployment name and connector id, lowercased) is `available`:

  ```bash
  aws rds describe-db-clusters --db-cluster-identifier dataspaceconnector-<id> \
    --query 'DBClusters[0].[Status,EngineVersion,StorageEncrypted,ServerlessV2ScalingConfiguration]'
  ```

* The control-plane log shows the Tractus-X Flyway migration running against the empty database at first boot, one line per migration up to the current schema version, for example:

  ```
  Migrating schema "public" to version "1.0.0 - Connector Schema Init"
  ...
  Successfully applied 9 migrations to schema "public"
  ```

  On every later boot the same extension logs `Schema "public" is up to date. No migration necessary.`

* The task definitions of both planes carry `edc.datasource.default.url` pointing at the cluster endpoint, `tx.edc.postgresql.migration.enabled=true`, and the `EDC_DATASOURCE_DEFAULT_USER` / `EDC_DATASOURCE_DEFAULT_PASSWORD` secrets, and no `edc.ddb.table.name`:

  ```bash
  aws ecs describe-task-definition --task-definition <task definition ARN from the service> \
    --query 'taskDefinition.containerDefinitions[0].[environment,secrets]'
  ```

* Expected boot noise: three `ERROR` lines per plane from `CommonsConnectionPoolServiceExtension`, one each for `edc.datasource.default.url`, `.user` and `.password`. The connection pool extension first looks each setting up in the vault, which is AWS Secrets Manager restricted to the connector's own secret prefix, gets `AccessDenied`, logs it, and falls back to the configuration (`not found in vault, will fall back to Config`). The values do come from the configuration, so these lines are harmless.

## 6. End-to-end test

Run the S3 loopback of the [Validate Data Exchange](../kiro-power/steering/validate-data-exchange.md#phase-5-self-test-with-s3-loopback-recommended) workflow (Phase 5) against every connector: the connector offers an object from its own data-plane bucket, negotiates a contract with itself and pulls the object back through the data plane. It exercises every store (assets, policies, contract definitions, negotiations, agreements, transfer processes, EDRs, data-plane registry) in the persistence type under test.

Start the MCP server from the `mcp` directory with `EDC_USE_AWS_IAM=true`, `EDC_MULTI_CONNECTOR=true` and your AWS profile in the environment (see [mcp/README.md](../mcp/README.md)); `list_connectors` must return every configured connector. Then run the workflow once per `connector_id`. The test passes when the fetched payload equals the uploaded object. Terminate the transfer afterwards.

### Confirming the rows landed in Aurora

The runtime answering the Management API does not prove where it stored the data. For a `postgres` connector, read the tables. The cluster is only reachable from inside the VPC, so enable the RDS Data API on the test cluster and query through it with the cluster's credentials secret (output `EdcAuroraSecretArn` of the connector stack). The role you run these commands with needs `rds:EnableHttpEndpoint` on the cluster, `rds-data:ExecuteStatement` on the cluster and `secretsmanager:GetSecretValue` on that secret:

```bash
aws rds enable-http-endpoint --resource-arn <cluster ARN>
aws rds-data execute-statement --resource-arn <cluster ARN> --secret-arn <EdcAuroraSecretArn> \
  --database edc --format-records-as JSON \
  --sql "select version, description, success from flyway_schema_history order by installed_rank"
aws rds-data execute-statement --resource-arn <cluster ARN> --secret-arn <EdcAuroraSecretArn> \
  --database edc --format-records-as JSON \
  --sql "select asset_id from edc_asset"
aws rds-data execute-statement --resource-arn <cluster ARN> --secret-arn <EdcAuroraSecretArn> \
  --database edc --format-records-as JSON \
  --sql "select transferprocess_id, state, transfer_type from edc_transfer_process"
```

After one loopback run, `edc_asset` holds the test asset, `edc_contract_agreement` one agreement and `edc_transfer_process` the consumer and provider processes. A paused cluster answers the first statement with `DatabaseResumingException`; retry after a few seconds. The Data API stays enabled on the cluster; disable it again with `aws rds disable-http-endpoint` if the cluster outlives the test.

## 7. Teardown

Follow [Teardown](../README.md#teardown): delete the connector YAML files from the config repository and push, wait for the pipeline to remove the connector stacks, then delete `DataspaceConnector-SharedInfra` and `DataspaceConnectorPipelineStack`, and finally the portal admin secret.

With `stateRemovalPolicy: DESTROY` the Aurora clusters go with their connector stacks. With `RETAIN`, delete each retained cluster (disable deletion protection first), its DB subnet group, its credentials secret and its security group before the `SharedInfra` stack, or the VPC deletion fails.
