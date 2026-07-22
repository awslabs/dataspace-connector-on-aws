# Management API Access Patterns

This guide covers how to configure access to the EDC Management API when deploying connectors with Dataspace Connector on AWS. It addresses three scenarios: single-account access, cross-account access, and per-connector access segregation.

## How Authentication Works

The Management API is deployed behind Amazon API Gateway with IAM authorization (`AWS_IAM`). Callers sign requests with AWS SigV4 using their IAM credentials. API Gateway evaluates two policies:

- **Resource policy** (attached to the API): controls which principals are allowed to invoke the API
- **Caller's IAM policy** (attached to the caller's role): controls which paths and methods the caller can invoke

The interaction between these policies depends on whether the caller is in the same account or a different account.

## Single-Account Access

When the caller is in the same AWS account as the API, **either** the resource policy **or** the caller's IAM policy is sufficient to grant access ([authorization flow reference](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-authorization-flow.html)).

### Setup

Add the caller's IAM role ARN to `managementApiPrincipals` in `deployment.yaml`:

```yaml
managementApiPrincipals:
  - "arn:aws:iam::111122223333:role/Admin"
  - "arn:aws:iam::111122223333:role/MyAppRole"
```

The caller's IAM role needs a policy allowing `execute-api:Invoke`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "execute-api:Invoke",
      "Resource": "arn:aws:execute-api:eu-central-1:111122223333:1234567890/management/*/*"
    }
  ]
}
```

Alternatively, for same-account callers, the role does not need to be listed in `managementApiPrincipals` at all; a scoped IAM policy alone is sufficient.

## Cross-Account Access

When the caller is in a different AWS account, **both** the resource policy **and** the caller's IAM policy must explicitly allow access ([authorization flow reference](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-authorization-flow.html)). No cross-account role assumption (`sts:AssumeRole`) is needed. API Gateway supports direct cross-account invocation via resource policies, similar to S3 bucket policies or Lambda resource policies.

### How It Works

1. A container or application in Account A signs the request with SigV4 using Role A's credentials
2. The request arrives at the API Gateway in Account B
3. API Gateway evaluates: the resource policy (must explicitly allow Role A) and Role A's IAM policy (must allow `execute-api:Invoke` on Account B's API)
4. Both allow → request proceeds

The caller never assumes a role in Account B. The SigV4 signature carries Account A's identity directly.

### Setup

**API side (Account B), `deployment.yaml`:**

```yaml
managementApiPrincipals:
  - "arn:aws:iam::111122223333:role/CrossAccountEdcClient"
```

**Caller side (Account A), IAM policy on the calling role:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "execute-api:Invoke",
      "Resource": "arn:aws:execute-api:eu-central-1:444455556666:1234567890/management/*/*"
    }
  ]
}
```

Note the resource ARN references Account B's account ID and API ID. The caller in Account A can invoke the API in Account B directly without assuming any role in Account B.

### Organization-Level Trust

If all cross-account callers are in the same AWS Organization, use `aws:PrincipalOrgID` instead of listing individual principal ARNs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": "*",
      "Action": "execute-api:Invoke",
      "Resource": "execute-api:/*",
      "Condition": {
        "StringEquals": {
          "aws:PrincipalOrgID": "o-a1b2c3d4e5"
        }
      }
    }
  ]
}
```

This is a single statement with a fixed size that covers unlimited accounts in the organization. Per-connector or per-path scoping is enforced by each caller's IAM policy.

> [!NOTE]
> The project does not yet include a dedicated YAML field for Org-based resource policies. Configure this manually via the API Gateway console or by adding a custom resource policy in the CDK stack.

## Per-Connector Access Segregation

When deploying multiple connectors into shared infrastructure, you may need to restrict which IAM principals can access which connector's Management API. For example, in a multi-tenant deployment, each tenant should only be able to manage their own connector.

The Management API routes are namespaced under `/{connectorId}/`:

```
https://{api-id}.execute-api.{region}.amazonaws.com/management/{connectorId}/v3/assets
https://{api-id}.execute-api.{region}.amazonaws.com/management/{connectorId}/v3/policydefinitions
...
```

The `execute-api:Invoke` resource ARN supports path-level scoping, which maps directly to the connector ID path segment.

### Same-Account: Per-Connector Roles

Create a dedicated IAM role per connector with a policy scoped to that connector's path:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "execute-api:Invoke",
      "Resource": "arn:aws:execute-api:eu-central-1:111122223333:1234567890/management/*/connector-a/*"
    }
  ]
}
```

This role can invoke any method on any path under the `connector-a` connector, but receives a 403 when attempting to access any other connector's routes.

These per-connector roles do **not** need to be listed in `managementApiPrincipals`. For same-account callers, the IAM policy alone is sufficient for authorization.

#### Example: Multiple Connectors

```yaml
# deployment.yaml: broad admin access
managementApiPrincipals:
  - "arn:aws:iam::111122223333:role/Admin"
```

Then create additional IAM roles (e.g., `edc-connector-a`, `edc-connector-b`, `edc-connector-c`), each with a policy targeting their connector:

```
arn:aws:execute-api:eu-central-1:111122223333:1234567890/management/*/connector-a/*
arn:aws:execute-api:eu-central-1:111122223333:1234567890/management/*/connector-b/*
arn:aws:execute-api:eu-central-1:111122223333:1234567890/management/*/connector-c/*
```

The Admin role retains access to all connectors. Each per-connector role is isolated. The resource policy remains unchanged regardless of how many per-connector roles exist. This approach scales to any number of connectors.

### Cross-Account: Per-Connector Roles

For cross-account per-connector access, the resource policy must acknowledge the caller. Two approaches:

**Individual principals (up to ~80 connectors at default quota):**

```yaml
# deployment.yaml
managementApiPrincipals:
  - "arn:aws:iam::444455556666:role/Admin"
  - "arn:aws:iam::111122223333:role/edc-connector-a"
  - "arn:aws:iam::777788889999:role/edc-connector-b"
```

The resource policy grants broad API access. Per-connector path scoping is enforced by each cross-account role's IAM policy.

The resource policy has a default size limit of 8,192 characters, adjustable via [Service Quotas](https://console.aws.amazon.com/servicequotas/home/services/apigateway/quotas/L-8B81B02C) ([API Gateway quotas reference](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html)). At ~80 characters per ARN, this supports approximately 80 cross-account principals before requiring a quota increase.

**Organization-level trust (unlimited scale):**

Use the `aws:PrincipalOrgID` condition described in the [Organization-Level Trust](#organization-level-trust) section above. This has a fixed resource policy size regardless of the number of connectors or accounts. Each cross-account caller's IAM policy scopes access to their specific connector path.

## IAM Policy Resource ARN Reference

The resource ARN format for `execute-api:Invoke`:

```
arn:aws:execute-api:{region}:{account-id}:{api-id}/{stage}/{HTTP-VERB}/{resource-path}
```

In this project, the stage name is `management` (the API Gateway deployment stage). The `{resource-path}` begins with the `{connectorId}` segment followed by the EDC API path.

| Pattern | Grants access to |
|---------|-----------------|
| `arn:aws:execute-api:eu-central-1:111122223333:1234567890/management/*/connector-a/*` | All methods, all paths under `connector-a` |
| `arn:aws:execute-api:eu-central-1:111122223333:1234567890/management/GET/connector-a/*` | Read-only access to `connector-a` |
| `arn:aws:execute-api:eu-central-1:111122223333:1234567890/management/*/connector-a/v3/assets` | All methods on `/v3/assets` only |
| `arn:aws:execute-api:eu-central-1:111122223333:1234567890/management/*/*` | All connectors (admin access) |

Use wildcards (`*`) for stage, HTTP verb, or path segments as needed. The API ID is found in the CDK stack output `EdcApiManagementApiEndpoint`.

For the full resource ARN specification, see the [API Gateway IAM policy reference](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-control-access-using-iam-policies-to-invoke-api.html).
