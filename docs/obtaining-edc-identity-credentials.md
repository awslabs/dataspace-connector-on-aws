# Obtaining EDC Identity Credentials from the Cofinity-X Portal

This guide walks through retrieving all identity credentials required to configure an EDC connector deployed with *Dataspace Connector on AWS*. Every value in the `edcIam` section of your connector's YAML configuration comes from the Cofinity-X Portal [Beta](https://portal.beta.cofinity-x.com/) or [Production](https://myportal.cofinity-x.com/).

## Prerequisites

- Your organization is onboarded to the Catena-X data space
- You have access to the relevant Cofinity-X Portal instance (Beta or Production)

## Step 1: Navigate to Technical User Management

From the Cofinity-X Portal, open **Technical Setup** in the top navigation bar and select **Technical User Management**.

![Navigate to Technical User Management](../img/obtaining-edc-identity-credentials-1.png)

## Step 2: Create an External Technical User

Click the button to create a new technical user. In the creation dialog:

1. Enter a **Username** and **Description** that identify this connector (e.g., `edc-connector-a`)
2. Select **External technical user profile**
3. Under the external profile, select **Identity Wallet Management**
4. Click **Confirm**

![Technical User Creation dialog](../img/obtaining-edc-identity-credentials-2.png)

> [!IMPORTANT]
> We recommend creating one dedicated technical user per EDC connector. Sharing technical users across connectors is possible but means those connectors share the same OAuth 2.0 credentials, which limits your ability to rotate secrets or revoke access independently.

Technical user creation takes a couple of minutes to complete.

## Step 3: Retrieve Client ID and Secret

Once the technical user is active, open its details page. At the bottom, you will find the **Client ID** and **Secret** fields.

![Technical User Details — Client ID and Secret](../img/obtaining-edc-identity-credentials-3.png)

These two values map to your connector configuration as follows:

| Portal Field | Configuration Target |
|---|---|
| **Client ID** | `stsOauthClientId` in your `connector-<id>.yaml` |
| **Secret** | Stored in AWS Secrets Manager (not in YAML) |

The client secret must be stored manually in AWS Secrets Manager after EDC deployment is complete. See [Adding a Connector](../README.md#adding-a-connector) in the README for details.

## Step 4: Navigate to Connector Registration

The remaining identity values are located on the connector registration page. Open **Technical Setup** → **Connector Registration**.

![Navigate to Connector Registration](../img/obtaining-edc-identity-credentials-4.png)

## Step 5: Open Connector Configuration Details

On the Connector Registration page, click the **small arrow icon (→)** on the right side of the "Connector Configuration Details" section at the top to open the configuration values dialog.

![Click the arrow to expand connector details](../img/obtaining-edc-identity-credentials-5.png)

## Step 6: Map Portal Values to YAML Configuration

The "Configure Your Connector" dialog displays all remaining identity values required for EDC configuration. The fields are listed in the same order as the `edcIam` section in your `connector-<id>.yaml`.

![Configure Your Connector — all EDC identity values](../img/obtaining-edc-identity-credentials-6.png)

### Field Mapping

| Portal Field | YAML Field (`edcIam`) | Description |
|---|---|---|
| `trusted_issuer` | `trustedIssuer` | DID of the trusted credential issuer |
| `dcp.sts.oauth.token.url` | `stsOauthTokenUrl` | Token endpoint of the DIM instance |
| `dcp.sts.oauth.client.id` | `stsOauthClientId` | Technical user client ID (from Step 3) |
| `dcp.sts.dim.url` | `stsDimUrl` | Base URL of your DIM instance |
| `participant_id` | `participantId` | Your organization's Business Partner Number (BPN) |
| `dcp.id` | `dcpId` | Your connector's Decentralized Identifier (DID) |
| `DID Resolver` | `didResolver` | BPN/DID Resolution Service (BDRS) URL |

> [!NOTE]
> The `dcp.sts.oauth.client.secret_alias` field shown in the portal is not configured in YAML — in *Dataspace Connector on AWS*, the OAuth 2.0 client secret is stored in AWS Secrets Manager (see Step 3).

## See Also

- [EDC Identity (`edcIam`) configuration reference](../README.md#edc-identity-edciam)
- [Connector YAML schema](../README.md#connectorsconnector-idyaml)
