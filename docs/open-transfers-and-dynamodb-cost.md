# Open Transfers and DynamoDB Cost

On this project's DynamoDB-backed stores, an idle-looking connector can run up a bill that resembles a busy one. The cause is open data transfers: EDC pull transfers stay active until explicitly ended, and each one a connector serves keeps consuming DynamoDB request units. This note explains that cost model and how to control it.

## How open transfers drive cost

DynamoDB consumption scales with the number of **open** transfers a connector serves, not with how much data moves through them. Each active transfer keeps a `DataFlow` in the `STARTED` state on the provider data plane. To retain ownership of that flow, the data plane periodically re-stamps it — a *flow-lease* refresh — and on a DynamoDB-backed store every refresh is a billed write. The number of open flows times the refresh rate sets the connector's standing request rate. Three properties make this easy to miss:

- **It looks like idle load.** A connector serving transfers that nobody is actively pulling still refreshes each flow's lease to retain ownership, so its request rate stays elevated with no visible activity.
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

Two independent levers control this cost.

**Reduce the number of open transfers.** Terminate transfers when the agreed period ends or the consumer no longer needs the data. Because neither credential policies nor legal end dates do this for you, it is the provider's responsibility, best handled by the surrounding EDC integration layer.

**Reduce the standing cost of each open transfer.** The recurring cost of an open flow is its flow-lease refresh rate. This deployment exposes the refresh interval as the per-connector `dataPlaneFlowLeaseMillis` setting (mapping to EDC's `edc.dataplane.state-machine.flow.lease.time`), defaulting to `10000` (10s) in place of EDC's own 500ms default — a 20x longer refresh interval, sharply cutting the standing write rate per open flow. Raise it to cut cost further. The tradeoff is failover latency: an unrefreshed flow is treated as abandoned after `dataPlaneFlowLeaseMillis × 5`, after which a second data-plane runtime may take it over. A single-runtime-per-connector deployment has no peer to take over, so a longer interval costs nothing operationally; multi-runtime (HA) data planes should keep it short enough for acceptable failover. Note that the effective interval is `max(dataPlaneFlowLeaseMillis, dataPlaneStateMachineIterationMillis)` — lowering it below the data-plane iteration interval has no effect.

## See Also

- [Management API Access Patterns](management-api-access-patterns.md): invoking `terminate` and other Management API calls
- [EDC Control Plane](https://eclipse-edc.github.io/documentation/for-adopters/control-plane/#transfer-processes): transfer process states, flow types, and the Policy Monitor
- [EDC Data Plane Signaling](https://eclipse-edc.github.io/documentation/for-contributors/data-plane/data-plane-signaling/): provider `DataFlow` lifecycle
- [Tractus-X EDC Policies](https://github.com/eclipse-tractusx/tractusx-edc/blob/main/docs/usage/management-api-walkthrough/02_policies.md): Catena-X policy constraints (CX-0152)
