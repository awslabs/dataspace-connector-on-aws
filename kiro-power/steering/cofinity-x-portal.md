# Cofinity-X Portal and Catena-X Reference

Background knowledge for working with the Cofinity-X Portal and Catena-X when developing or operating this project. Consult this when implementing or debugging Portal API interactions, gathering connector identity values, or extending the portal integration in `cdk/lib/portal/`.

## Authoritative documentation sources

Prefer these over general web search:

- **Eclipse Tractus-X portal-backend** (`github.com/eclipse-tractusx/portal-backend`) is the source code behind the Cofinity-X Portal API. It is the definitive reference for endpoint contracts: request and response shapes, field names, and whether an endpoint expects JSON or form data. When unsure about a contract, read the controller (for example `ConnectorsController.cs`) and its input models rather than guessing.
- **Tractus-X EDC** (`github.com/eclipse-tractusx/tractusx-edc`) documents connector configuration and environment variables.
- **Eclipse Dataspace Components** (`github.com/eclipse-edc`) and the **Tractus-X docs-kits** (`eclipse-tractusx.github.io/docs-kits`) cover EDC and Catena-X concepts.
- **Catena-X** (`catena-x.net`) covers dataspace onboarding and the conformity assessment process.
- The Cofinity-X Portal: Beta `portal.beta.cofinity-x.com`, Production `myportal.cofinity-x.com`. The project guide `docs/cofinity-x-portal-setup.md` covers the admin technical user.

## Portal API essentials

- Base URLs:
  - Beta: `https://portal-backend.beta.cofinity-x.com/api/administration`
  - Production: `https://portal-backend.svc.cofinity-x.com/api/administration`
- Authentication is OAuth 2.0 client credentials against Cofinity-X Keycloak:
  - Beta token endpoint: `https://centralidp.beta.cofinity-x.com/auth/realms/CX-Central/protocol/openid-connect/token`
  - Production uses the `svc` host in place of `beta`.
- Automation must use a technical user. Human portal accounts are federated through corporate single sign-on and cannot use the client-credentials grant (only interactive browser login), so scripts and pipelines authenticate as a technical user with a client id and secret.
- Roles determine what a technical user can do. This project uses:
  - Pipeline admin user: **Connector Management** only (create, read, update and delete connectors and technical users).
  - Per-connector user: **Identity Wallet Management**, created by the pipeline.

## Known API constraints

- **Connector registration is form-encoded, not JSON.** `POST /connectors` binds an ASP.NET `[FromForm]` model with PascalCase fields: `Name`, `ConnectorUrl`, `Location` (a two-letter country code), and `TechnicalUserId`. A JSON body returns HTTP 400 with every field reported as missing. Send `application/x-www-form-urlencoded`.
- **Technical users are deleted through their connector.** Connector Management has no direct technical-user delete; `DELETE /connectors/{id}?deleteServiceAccount=true` removes the connector and its linked technical user. The portal refuses it with 409 `TECHNICAL_USER_CREATION_IN_PROGRESS` while the technical user is still `PENDING`.
- **Organization identity values cannot be read through the API by a technical user.** `GET /companydata/decentralidentity/urls` requires a human-role permission. The project derives them instead: the company DID is `did:web:<portal-backend host>:api:administration:staticdata:did:<BPNL>`, and the trusted issuer, BDRS and wallet (DIM) URLs are constant per portal environment.
- **`GET /serviceaccount/owncompany/serviceaccounts/{id}` returns the client id and secret on every call,** not only at creation. The client secret never needs to be cached; read it when needed.

## Developing and testing against the Portal API

- Verify an endpoint's contract against the portal-backend source before writing code against it, especially for write operations (see the form-encoded registration constraint above).
- Probe interactively first: request a token from Keycloak with the technical user's credentials, then call the endpoint with `curl`. This is the fastest way to confirm which endpoints and roles are available and to read the exact error bodies (for example, a 403 reveals a missing permission).
- Test write operations live, not only reads. A harness that only authenticates, reads details, and lists will not exercise the create, register, and delete paths where contract mismatches surface.
- Keep technical-user credentials out of source control (for example in a git-ignored `.env`), and never log secret values.

## Technical user lifecycle (DIM)

Technical users are provisioned asynchronously through the Decentralized Identity Management (DIM) service. A new user starts in `PENDING` (client id null) and becomes `ACTIVE` once DIM finishes, observed at 6 to 8 minutes. The connector stack's `PortalConnector` resource waits for `ACTIVE` before the EDC services start.

## EDC identity mapping

The EDC setting `edc.participant.id` is set to the organization's Decentralized Identifier (DID), while the Business Partner Number (BPN) maps to `tractusx.edc.participant.bpn`. This is a Tractus-X convention. The YAML field `bpnl` (or `portal.bpnl`) is the BPN.
