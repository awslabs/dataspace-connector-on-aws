# Open Transfers and DynamoDB Cost

On this project's DynamoDB-backed stores, an idle-looking connector can run up a bill that resembles a busy one. The cause is open data transfers: EDC pull transfers stay active until explicitly ended, and each one a connector serves keeps consuming DynamoDB request units. This note explains that cost model and how to control it.

## How open transfers drive cost

DynamoDB consumption scales with the number of **open** transfers a connector serves, not with how much data moves through them. Each active transfer keeps a `DataFlow` on the provider data plane, which the data plane and its selector poll and re-lease on every state-machine iteration. Three properties make this easy to miss:

- **It looks like idle load.** A connector serving transfers that nobody is actively pulling still polls and leases them continuously, so its request rate stays high with no visible activity.
- **It is asymmetric.** The cost lands on the **provider**. A consumer only pulls and runs no serving flow, so its request rate stays near baseline no matter how many transfers it has open. The party that starts and then abandons a transfer is not the party that pays for it.
- **It is unbounded.** Nothing reaps open transfers automatically (see below), so the cost persists and accumulates until each transfer is explicitly terminated.

> [!IMPORTANT]
> This is a property of **DynamoDB on-demand persistence**, where every poll and lease is a billed request. EDC's state machines poll open transfers the same way on any backend, but against a provisioned relational store such as PostgreSQL (EDC's default control-plane persistence) the same activity is absorbed into fixed database capacity rather than billed per request.

## Why transfers stay open

In the consumer-pull (EDR) pattern the transfer moves to `STARTED` and stays there: EDC does not complete it when data is retrieved, because a pull has no defined completion point. This is intended, so the consumer can pull repeatedly while the contract is valid (see [EDC transfer process states](https://eclipse-edc.github.io/documentation/for-adopters/control-plane/#transfer-process-states)). The EDR's access token expires and is refreshed out of band, but token expiry does not end the transfer.

## What ends a transfer, and what does not

- **Credential policy failure (automatic).** The [Policy Monitor](https://eclipse-edc.github.io/documentation/for-adopters/control-plane/#policy-monitor) re-evaluates each transfer's contract policy and terminates it when a constraint stops holding, for example if the consumer loses its `Membership` credential. A consumer that remains a valid member on a valid framework agreement is not affected by this.
- **Catena-X end dates (not enforced).** Catena-X' ODRL profile defines `DataUsageEndDate` and related constraints, but these are **legal terms, not technical controls**. The [`DataUsageEndDate` schema](https://raw.githubusercontent.com/catenax-eV/cx-odrl-profile/refs/heads/main/schema/constraint/data-usage-end-date-constraint-schema.json) uses the `eq` operator and defines its meaning in prose ("the Data Consumer shall no longer be entitled to use the Data and shall delete the Data ... the Agreement shall terminate upon expiry"). It states when access is legally over. It does not make the connector stop the flow or its cost.
- **Explicit termination (the technical lever).** `POST /v3/transferprocesses/{id}/terminate` ends the transfer and the cost it accrues (see [Management API Access Patterns](management-api-access-patterns.md)).

## Keeping cost down

Terminate transfers when the agreed period ends or the consumer no longer needs the data. Because neither credential policies nor legal end dates do this for you, it is the provider's responsibility, best handled by the surrounding EDC integration layer.

## See Also

- [Management API Access Patterns](management-api-access-patterns.md): invoking `terminate` and other Management API calls
- [EDC Control Plane](https://eclipse-edc.github.io/documentation/for-adopters/control-plane/#transfer-processes): transfer process states, flow types, and the Policy Monitor
- [EDC Data Plane Signaling](https://eclipse-edc.github.io/documentation/for-contributors/data-plane/data-plane-signaling/): provider `DataFlow` lifecycle
- [Tractus-X EDC Policies](https://github.com/eclipse-tractusx/tractusx-edc/blob/main/docs/usage/management-api-walkthrough/02_policies.md): Catena-X policy constraints (CX-0152)
