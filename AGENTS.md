# AGENTS.md

Agent guidance for this repo. Humans: start with `README.md`.

## What this is
A CDK-deployed, multi-connector distribution of Tractus-X EDC (Eclipse Dataspace
Components) on AWS: custom EDC control-plane/data-plane runtimes with DynamoDB-backed
stores, API Gateway front doors, a GitOps deploy pipeline, and an MCP server for
operating connectors.

## Layout
- `edc/` — EDC runtimes (Gradle/Kotlin, Java 17). `control-plane/`, `data-plane/`
  are shadowJar apps on the Tractus-X base; `extensions/` holds the custom DynamoDB
  stores and S3 EDR extension. Versions pinned in `edc/gradle/libs.versions.toml`.
- `cdk/` — AWS CDK (TypeScript) infra + deploy pipeline. `cdk/api/*.yaml` are the
  API Gateway OpenAPI specs (spec-driven `SpecRestApi`, `http_proxy` passthrough).
- `mcp/` — Python MCP server (`server.py`) exposing EDC management primitives.
- `kiro-power/` — operational runbooks (`POWER.md`, `steering/`).
- `scripts/` — maintenance tooling (e.g. `regenerate-api-specs.py`).

## Build & test
- EDC: `cd edc && ./gradlew build` (also `shadowJar`, `test`, `ktlintFormat`).
- CDK: `cd cdk && npm ci && npx tsc && npx cdk synth`.
- MCP: `cd mcp && uv run pytest`.

## Docs of record
`README.md` (setup/config/deploy) · `CONTRIBUTING.md` (workflow) ·
`kiro-power/steering/` (deploy + data-exchange validation runbooks).
