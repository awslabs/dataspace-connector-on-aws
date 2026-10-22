# Deploy Connector Workflow

Guides the agent through deploying Dataspace Connectors on AWS. Follow the phases in order and ask the user for input where indicated.

`deploy.sh` creates a CDK pipeline and a configuration repository. From then on the pipeline deploys whatever the configuration repository holds: `<deploymentName>-SharedInfra`, one `<deploymentName>-Connector-<connectorId>` stack per connector file, and one `<deploymentName>-BaSyx-<BPNL>` stack per `basyx` entry. `deploymentName` defaults to `DataspaceConnector`. Each connector stack manages the connector's Cofinity-X Portal lifecycle: it creates the connector's technical user, derives the EDC identity, and registers the connector; deleting the stack deletes both.

---

## Phase 1: Verify Prerequisites

```bash
node --version && python3 --version && uv --version && git --version && aws sts get-caller-identity
```

Node.js 24+, Python with `uv` (for the MCP server), Git, and working AWS credentials are required. The CDK CLI comes from `cdk/package.json`. Java and a container runtime are not needed: the pipeline builds the EDC images.

Store the AWS profile and the identity ARN; the ARN goes into `managementApiPrincipals` in Phase 4. If `$AWS_PROFILE` is unset, ask the user which profile to use.

---

## Phase 2: Choose Region

Ask the user for the AWS region (default `eu-central-1`).

---

## Phase 3: Cofinity-X Portal Admin User

The user does this once per organization (BPNL), following `docs/cofinity-x-portal-setup.md`: create an internal technical user with only the **Connector Management** role in the portal ([Beta](https://portal.beta.cofinity-x.com/); only beta is supported yet), and store its credentials in Secrets Manager as `<deploymentName>/portal-admin/<BPNL>`, holding `{"clientId":"...","clientSecret":"..."}`. Nothing else is created in the portal by hand.

---

## Phase 4: Write the Configuration

`deploy.sh` seeds the configuration repository from `cdk/config-templates/`, so edit those files first. The README's Configuration section documents every key; ask the user only for values that differ from the defaults.

- `deployment.yaml`: set `portal.bpnl` to the organization's BPNL and add the identity ARN from Phase 1 under `managementApiPrincipals` (and `observabilityApiPrincipals` if wanted).
- `connectors/`: replace `connector-example.yaml` with one `connector-<id>.yaml` per connector, each with its `connectorId`. Set `bpnl` only for a connector of a different organization.

---

## Phase 5: Deploy

```bash
export AWS_PROFILE=<profile>
export AWS_REGION=<region>
./deploy.sh
```

The pipeline then runs on its own. On a connector's first deploy its stack waits for the portal to activate the new technical user, which takes about 7 minutes. Monitor with `aws codepipeline get-pipeline-state --name <deploymentName>Pipeline`.

Later changes (adding or removing connectors, changing `appVersion`) are pushes to the configuration repository, not edits to the templates.

---

## Phase 6: Configure MCP Access

After the deploy stage completes, write or merge this entry into `.kiro/settings/mcp.json`, keeping other servers and replacing an existing entry's values. All values are known, so do not prompt the user.

```json
{
  "mcpServers": {
    "dataspace-connector-on-aws": {
      "command": "uv",
      "args": ["--directory", "<absolute-path-to-mcp-directory>", "run", "dataspace-connector-mcp"],
      "env": {
        "EDC_USE_AWS_IAM": "true",
        "EDC_MULTI_CONNECTOR": "true",
        "AWS_REGION": "<region>",
        "AWS_PROFILE": "<profile>"
      }
    }
  }
}
```

The server discovers the connectors and their API URLs from CloudFormation. With a custom `deploymentName`, also set `DEPLOYMENT_NAME` so it finds the stacks.

---

## Phase 7: Validate MCP Access

```python
list_connectors()
query_resources(connector_id="<connectorId>", resource_type="assets", limit=1)
```

If both succeed, continue with the **validate-data-exchange** steering file. If a call fails, check that the credentials are valid, the identity may invoke the Management API (`managementApiPrincipals` or an IAM policy), and the region is correct.
