# Prototype Use Case Research Workflow

This steering file guides the agent through deeply understanding a specific Catena-X use case and producing a complete compliance analysis. The goal is to load all three authoritative data sources — KIT documentation, Catena-X standards, and semantic data models — extract every normative requirement, and deliver a consolidated compliance brief that a developer (or a subsequent build-phase steering file) can use to implement a compliant prototype.

The connector must already be deployed and MCP tools connected (see the **deploy-connector** steering file).

**Implementation context:** This power is part of an AWS project to help accelerate Catena-X use case implementation. The deployed connector exposes 4 API Gateway endpoints (Management API, DSP API, Data Plane API, Observability API) and an S3 bucket for data that is shared or received over Catena-X. Any use-case application built on top of this connector integrates through these interfaces — it does not access the connector's internal infrastructure directly. When the compliance brief identifies implementation needs (backend APIs, data storage, event processing, document handling, etc.), the agent should propose AWS services that best fit those needs.

**Why this matters:** Catena-X values compliance. Any implementation MUST 100% conform with the KIT documentation, the applicable Catena-X standards, and the semantic data models. Normative statements using RFC 2119 keywords (MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, OPTIONAL) define hard compliance boundaries — violating a MUST or MUST NOT renders an implementation unsuitable for production use in Catena-X.

---

## Phase 1: Identify the Use Case

Ask the user:
> "Which Catena-X use case would you like to research? You can:
> - Name a KIT (e.g., 'Company Certificate Management')
> - Describe a business scenario (e.g., 'exchanging quality data with suppliers')
> - Paste a KIT URL
>
> I'll then load all KIT documentation, applicable standards, and semantic models to produce a full compliance analysis."

If the user provides a KIT URL, extract the KIT name from it. If they describe a scenario, use the KIT homepage at `https://eclipse-tractusx.github.io/Kits` to identify the most relevant KIT(s).

Store the chosen use case name — it drives all subsequent research.

---

## Phase 2: Load the KIT Documentation

KITs (Keep It Together) are the primary entry point for understanding a Catena-X use case. Each KIT is published at `https://eclipse-tractusx.github.io/docs-kits/`.

### Step 2.1: Discover the KIT Structure

The KIT landing page URL follows this pattern:
```
https://eclipse-tractusx.github.io/docs-kits/category/<kit-name-lowercase-hyphenated>-kit
```

For example:
- Company Certificate Management → `category/company-certificate-management-kit`
- Product Carbon Footprint → `category/product-carbon-footprint-kit`
- Traceability → `category/traceability-kit`

Fetch the KIT landing page to discover the available sub-pages. If the URL pattern doesn't match, search for the KIT using web search with `site:eclipse-tractusx.github.io`.

Default to the latest available version of the KIT documentation (the version selector at the top of the page shows the current release).

### Step 2.2: Load the Adoption View

KITs typically have an Adoption View with business-focused documentation. Fetch it from:
```
https://eclipse-tractusx.github.io/docs-kits/kits/<kit-name-lowercase-hyphenated>-kit/adoption-view/
```

Extract and record:
- **Use case description** — What business problem does this solve?
- **Roles** — Who are the Data Providers, Data Consumers, and Business Application Providers?
- **Interaction patterns** — PUSH vs PULL data exchange, notification flows
- **Referenced standards** — Which CX-XXXX standards are mentioned? Collect every single one.
- **Referenced semantic models** — Which `io.catenax.*` models are mentioned? Collect every single one.
- **Policy requirements** — What usage policies (UsagePurpose, FrameworkAgreement) are mentioned?

### Step 2.3: Load the Development View

Fetch all Development View pages. These are typically found under:
```
https://eclipse-tractusx.github.io/docs-kits/kits/<kit-name-lowercase-hyphenated>-kit/development-view/
```

Common sub-pages include architecture overviews, API guides, and requirements. Fetch each one. Extract and record:
- **API specifications** — Endpoints, request/response formats, HTTP methods
- **EDC asset structure** — How assets must be registered (type, subject, version properties using `dct:type`, `dct:subject`, `cx-common:version` from the Catena-X taxonomy)
- **Data exchange flow** — Step-by-step sequence of EDC operations (catalog, negotiation, transfer)
- **Error handling requirements** — Required HTTP status codes and error responses
- **Notification message formats** — Header structure (`senderBpn`, `receiverBpn`, `context`, `messageId`, `version`) and content payloads
- **Any additional standards or semantic models referenced** — Add these to the lists from Step 2.2

### Step 2.4: Load the Changelog

Fetch the changelog page if available:
```
https://eclipse-tractusx.github.io/docs-kits/kits/<kit-name-lowercase-hyphenated>-kit/changelog
```

Note any breaking changes or deprecations in the current release that affect implementation.

### Step 2.5: Present the KIT Summary

Present a structured summary to the user:
> "Here's what I found in the **[KIT Name]** KIT:
>
> **Business Context:** [1-2 sentence summary]
>
> **Roles:**
> - Data Provider: [responsibilities]
> - Data Consumer: [responsibilities]
> - Business Application Provider: [responsibilities]
>
> **Data Exchange Patterns:**
> - [PULL/PUSH/Notification patterns identified]
>
> **APIs Defined:**
> - [List of API endpoints with brief descriptions]
>
> **Standards Referenced:** [CX-XXXX list — these will all be loaded in full next]
>
> **Semantic Models Referenced:** [io.catenax.* list — these will all be loaded next]
>
> **Usage Policy Requirements:** [UsagePurpose values, FrameworkAgreement requirements]
>
> I'll now load every referenced standard in full and extract all normative compliance requirements."

---

## Phase 3: Load the Catena-X Standards

Standards are published at `https://catenax-ev.github.io/docs/standards/` and define the normative compliance requirements. Each standard follows the naming convention `CX-XXXX-StandardName`.

### Step 3.1: Build the Complete Standards List

Start with every standard referenced in the KIT (from Phase 2). Classify each standard into one of two categories:

**Use-case standards** — Standards that define the specific use case's APIs, data models, policies, and message flows. These are the primary standards (e.g., CX-0135 for CCM) and any standards they reference that contain use-case-relevant normative requirements (e.g., CX-0151 for notification format, CX-0152 for policy constraints).

**Infrastructure standards** — Standards that define foundational dataspace infrastructure not specific to this use case (e.g., CX-0018 Dataspace Connectivity, CX-0003 SAMM Aspect Meta Model, CX-0010 Business Partner Number, CX-0001 EDC Discovery API). These are prerequisites for any Catena-X participation and are handled by the connector deployment itself.

For each use-case standard, after loading it, check its "NORMATIVE REFERENCES" section (typically Section 4.1). Classify newly discovered references as use-case or infrastructure. Add use-case standards to the load list. Continue recursively until no new use-case standards are discovered.

### Step 3.2: Load Use-Case Standards in Full

For each use-case standard on the list, fetch the full content from:
```
https://catenax-ev.github.io/docs/standards/CX-XXXX-StandardName
```

IMPORTANT: Always use the current release URL path (`/docs/standards/`). NEVER use `/docs/next/standards/` — the "next" path contains draft standards from unreleased versions that may change.

**URL resolution:** The URL slug matches the standard number and a hyphenated version of the standard name, but slugs can contain typos or unexpected spellings (e.g., `CX-0152-PolicyConstrainsForDataExchange` uses "Constrains" not "Constraints"). If a URL returns 404:
1. Search using web search with `site:catenax-ev.github.io "CX-XXXX"` to find the exact URL
2. Fetch the standards overview page in rendered mode at `https://catenax-ev.github.io/docs/standards/overview` and scan the sidebar navigation for a link containing the standard number — the sidebar lists every published standard with its exact URL slug
3. As a last resort, try common slug variations (different casing, missing/extra words, typos in the original standard name)

Standards are structured with these key sections:
1. **Introduction** — Audience, scope, context (often non-normative)
2. **Application Programming Interfaces** (normative) — API endpoints, message formats, data asset structure, message flow expectations, policy constraints
3. **Aspect Models** (normative) — Semantic model identifiers (`urn:samm:io.catenax.*`), format requirements
4. **References** — Normative and non-normative references
5. **Conformance and Proof of Conformity** — How compliance is assessed

IMPORTANT: Load the FULL content of each use-case standard. Do not summarize or skip sections. The normative statements can appear anywhere in the document. If the fetched content appears truncated (e.g., ends mid-sentence, missing sections that the table of contents references), re-fetch using full mode or fetch in segments using `start_index` to ensure complete coverage. Missing normative statements due to truncation is a compliance risk.

### Step 3.3: List Infrastructure Standards (Do Not Load)

For transparency, list all infrastructure standards that were discovered as normative references but not loaded in full. Present them to the user:

> "**Infrastructure standards (not loaded — handled by connector deployment):**
> - CX-0018 Dataspace Connectivity — Defines EDC connector behavior and DSP protocol
> - CX-0003 SAMM Aspect Meta Model — Defines semantic modeling language
> - CX-0010 Business Partner Number — Defines BPNL/BPNS/BPNA format
> - CX-0001 EDC Discovery API — Defines connector discovery
>
> These are foundational standards required for any Catena-X participation. They are satisfied by the deployed connector infrastructure and do not contain use-case-specific normative requirements."

### Step 3.4: Extract Normative Statements

For each standard, systematically scan for RFC 2119 keywords appearing in ALL CAPITALS. These keywords have precise meanings per BCP 14 [RFC2119] [RFC8174]:

- **MUST / REQUIRED / SHALL** — Absolute requirement. Violation = non-compliant. No exceptions.
- **MUST NOT / SHALL NOT** — Absolute prohibition. Violation = non-compliant. No exceptions.
- **SHOULD / RECOMMENDED** — Strong recommendation. Deviation requires documented justification.
- **SHOULD NOT / NOT RECOMMENDED** — Strong discouragement. Use requires documented justification.
- **MAY / OPTIONAL** — Truly optional. Can be included or omitted freely.

For each normative statement, record:
- The exact statement (quote it verbatim)
- Which standard it comes from (CX-XXXX, section number)
- The compliance level (MUST, SHOULD, MAY)
- Which role it applies to (Data Provider, Data Consumer, Business Application Provider, all)

Pay special attention to:
- **Section "MESSAGE FLOW EXPECTATIONS"** — Contains the core behavioral requirements
- **Section "POLICY CONSTRAINTS FOR DATA EXCHANGE"** — Defines required policy structure and UsagePurpose values
- **Section "DATA ASSET STRUCTURE"** — Defines how EDC assets MUST be configured
- **Section "ASPECT MODELS"** — Defines which semantic model versions MUST be used

### Step 3.5: Load External Schema References

Standards may reference external schemas or constraint definitions that are critical for compliance. Scan each loaded standard for references to external URLs that define:
- **Policy constraint schemas** (e.g., the Catena-X Policy Schema at `https://w3id.org/catenax/2025/9/policy/`)
- **Constraint folders** listing valid leftOperands, rightOperands, and operators
- **Taxonomy definitions** (e.g., `https://w3id.org/catenax/taxonomy`)

For each external schema reference found:
1. Attempt to fetch the URL
2. If it resolves to a machine-readable schema (JSON Schema, JSON-LD context, TTL), load it and extract the relevant constraint definitions (valid leftOperands, allowed rightOperands per leftOperand, allowed operators)
3. If it does not resolve or is not machine-readable, note it as an open item that must be resolved during the build phase

Record all external schema references and their contents (or failure to load) — these are needed for the compliance brief.

### Step 3.6: Compile the Compliance Matrix

Present ALL normative requirements as a structured matrix, grouped by standard:

> "**Compliance Matrix for [Use Case]**
>
> ### CX-XXXX — [Standard Name]
>
> | # | Requirement (verbatim) | Section | Level | Applies To |
> |---|------------------------|---------|-------|------------|
> | 1 | "HTTP endpoints MUST NOT be called from a business partner directly. Rather, it MUST be called via a connector communication." | §2.1.4 | MUST | All |
> | 2 | "The property [type] MUST reference the name of the notification API as defined in the Catena-X taxonomy" | §2.1.4 | MUST | Data Provider |
> | 3 | "The rightOperand for the leftOperand UsagePurpose MUST include the following usage purpose: cx.ccm.base:1" | §2.1.7 | MUST | Data Provider |
> | ... | ... | ... | ... | ... |
>
> ### CX-YYYY — [Standard Name]
> | ... | ... | ... | ... | ... |
>
> ---
> **Total: N MUST requirements | N SHOULD requirements | N MAY requirements**
> **Standards loaded: [list all CX-XXXX numbers]**"

---

## Phase 4: Load the Semantic Data Models

Semantic models define the exact data structures for data exchange. They are published at `https://github.com/eclipse-tractusx/sldt-semantic-models/`.

### Step 4.1: Identify All Required Models

From the standards loaded in Phase 3, extract every semantic model identifier. These follow the pattern:
```
urn:samm:io.catenax.<model_name>:<version>
```

For example: `urn:samm:io.catenax.business_partner_certificate:3.1.0`

Also include any models referenced in the KIT documentation (Phase 2) that weren't explicitly mentioned in the standards.

The model name maps to a directory in the GitHub repository:
```
https://github.com/eclipse-tractusx/sldt-semantic-models/tree/main/io.catenax.<model_name>
```

### Step 4.2: Determine the Correct Version

Each model directory contains versioned subdirectories (e.g., `1.0.0/`, `2.0.0/`, `3.1.0/`). Fetch the model directory listing to see available versions.

Use the version specified in the standard. If the standard says "v3.1.0 or higher", use the latest available version that is in `release` status.

Check the `metadata.json` in each version directory for the model status:
```
https://raw.githubusercontent.com/eclipse-tractusx/sldt-semantic-models/main/io.catenax.<model_name>/<version>/metadata.json
```

- **release** — Stable, use this
- **draft** — Under development, may change — flag this to the user
- **deprecated** — End-of-life, do not use — flag this to the user

### Step 4.3: Load the Model Artifacts

Each version directory contains a `gen/` folder with pre-generated artifacts. For compliance analysis, load:

1. **JSON Schema** — Defines the exact JSON structure, field types, required fields, and validation constraints:
```
https://raw.githubusercontent.com/eclipse-tractusx/sldt-semantic-models/main/io.catenax.<model_name>/<version>/gen/<ModelName>-schema.json
```

2. **Example payload** — A valid example instance of the model:
```
https://raw.githubusercontent.com/eclipse-tractusx/sldt-semantic-models/main/io.catenax.<model_name>/<version>/gen/<ModelName>.json
```

3. **OpenAPI fragment** — API schema definition:
```
https://raw.githubusercontent.com/eclipse-tractusx/sldt-semantic-models/main/io.catenax.<model_name>/<version>/gen/<ModelName>.yml
```

Note: The `<ModelName>` in filenames uses PascalCase (e.g., `BusinessPartnerCertificate`), while the directory uses the full dotted namespace (e.g., `io.catenax.business_partner_certificate`). The PascalCase name is derived by converting the last segment of the namespace from snake_case — but edge cases exist. Always fetch the version directory listing first to discover the exact filenames rather than guessing.

### Step 4.4: Present the Data Model Summary

> "**Semantic Data Models for [Use Case]**
>
> | Model | Version | URN | Status | Purpose |
> |-------|---------|-----|--------|---------|
> | BusinessPartnerCertificate | 3.1.0 | urn:samm:io.catenax.business_partner_certificate:3.1.0 | release | Certificate data structure |
> | ... | ... | ... | ... | ... |
>
> **For each model:**
>
> ### [ModelName] v[version]
> **Required fields:** [list from JSON schema]
> **Optional fields:** [list from JSON schema]
> **Key constraints:** [enums, patterns, min/max values from JSON schema]
>
> **Example payload:**
> ```json
> [paste the example payload]
> ```"

---

## Phase 5: Cross-Reference and Produce the Compliance Brief

This phase ensures the three sources are aligned and produces the final deliverable — a **markdown file written to the workspace** that serves as the single source of truth for any subsequent build phase.

### Step 5.1: Verify Model-Standard Alignment

For each semantic model identified in Phase 4, confirm:
- The standard explicitly references this model version (or "this version or higher")
- The model's URN matches what the standard specifies in the "IDENTIFIER OF SEMANTIC MODEL" section
- The model status is `release`

Flag any mismatches to the user.

### Step 5.2: Verify Policy Requirements

Cross-reference the usage policy requirements across all loaded standards:
- What `UsagePurpose` value(s) are REQUIRED?
- What `FrameworkAgreement` value is REQUIRED?
- Are there additional constraints (e.g., `ContractReference` for bilateral agreements)?
- What access policy constraints are needed (e.g., `Membership` check)?
- What is the required ODRL profile IRI?

### Step 5.3: Verify EDC Asset Configuration

Cross-reference the asset structure requirements from the standards:
- What `dct:type` value must the asset use? (from the Catena-X taxonomy `cx-taxo:*`)
- What `dct:subject` value?
- What `cx-common:version` value?
- What `dataAddress` type? (`HttpData` for API endpoints, `AmazonS3` for file-based exchange)

### Step 5.4: Write the Compliance Brief to Disk

Write the compliance brief as a markdown file to `docs/compliance-brief-<use-case-kebab-case>.md` in the workspace root. Create the `docs/` directory if it doesn't exist.

For example: `docs/compliance-brief-company-certificate-management.md`

The file MUST contain all of the following sections with the exact structure shown below. This structure is designed so that a subsequent build-phase steering file or agent session can read it back into context and have everything needed to implement a compliant prototype.

```markdown
# Compliance Brief: [Use Case Name]

> Generated by the prototype-use-case research workflow.
> Source KIT version: [version, e.g., 26.03]
> Generated: [date]

---

## Sources

All URLs fetched during research, grouped by type:

### KIT Pages
| Page | URL |
|------|-----|
| [list every KIT page fetched: landing, adoption view, development view sub-pages, changelog] |

### Standards
| Standard | URL |
|----------|-----|
| [list every standard URL fetched] |

### Semantic Models
| Artifact | URL |
|----------|-----|
| [list every raw GitHub URL fetched: JSON schemas, example payloads, metadata files] |

### External Schemas
| Schema | URL |
|--------|-----|
| [list every external schema URL fetched or attempted] |

---

## 1. Use Case Overview

[2-3 sentence summary from KIT Adoption View]

## 2. Roles and Responsibilities

- **Data Provider:** [what they must do]
- **Data Consumer:** [what they must do]
- **Business Application Provider:** [what they must do]

## 3. Data Exchange Patterns

[PULL/PUSH/Notification — with sequence description for each pattern]

## 4. Standards

### Use-Case Standards (loaded in full)

| Standard | Version | Title | URL |
|----------|---------|-------|-----|
| CX-XXXX | vX.X.X | ... | https://catenax-ev.github.io/docs/standards/... |

### Infrastructure Standards (not loaded — satisfied by connector deployment)

| Standard | Title | Scope |
|----------|-------|-------|
| CX-XXXX | ... | ... |

## 5. Compliance Matrix

### CX-XXXX — [Standard Name]

| # | Requirement (verbatim) | Section | Level | Applies To |
|---|------------------------|---------|-------|------------|
| 1 | "..." | §X.X | MUST | All |

[Repeat for each use-case standard]

**Totals: N MUST | N SHOULD | N MAY | N RECOMMENDED**

## 6. Semantic Data Models

| Model | Version | URN | Status |
|-------|---------|-----|--------|
| ... | ... | ... | release |

### [ModelName] v[version]

**Required fields:** [list]
**Optional fields:** [list]
**Key constraints:** [enums, patterns, min/max]

<details>
<summary>JSON Schema</summary>

\`\`\`json
[full JSON schema content]
\`\`\`

</details>

<details>
<summary>Example Payload</summary>

\`\`\`json
[full example payload]
\`\`\`

</details>

## 7. EDC Configuration Requirements

### Notification API Asset

- **dct:type:** `cx-taxo:XXXX`
- **dct:subject:** `cx-taxo:XXXX`
- **cx-common:version:** `X.X`

### Certificate Data Asset (if PULL pattern)

- **dct:type:** `cx-taxo:XXXX`
- **dct:subject:** `cx-taxo:XXXX`

### Access Policy

- [required constraints, e.g., MembershipCredential verification]

### Usage Policy

- **FrameworkAgreement:** `DataExchangeGovernance:1.0`
- **UsagePurpose:** `cx.<usecase>.base:1`
- **Constraint chaining:** `odrl:and`
- **ODRL profile:** `https://w3id.org/catenax/...`

## 8. API Specifications

| Endpoint | Method | Offered By | Purpose | Context String |
|----------|--------|------------|---------|----------------|
| /path | POST | Provider/Consumer | ... | CompanyCertificateManagement-CCMAPI-...:1.0.0 |

### Notification Header Structure

[Required and optional header fields with types and patterns]

### Endpoint Details

[For each endpoint: request body schema, response codes, example payloads]

## 9. External Schema References

| Schema | URL | Status |
|--------|-----|--------|
| Catena-X Policy Schema | https://... | loaded / not resolvable |

[For loaded schemas: summary of valid constraints, leftOperands, rightOperands]
[For unresolvable schemas: note that this must be resolved during build phase]

## 10. Open Questions / Warnings

- [Any mismatches, deprecated models, ambiguous requirements, unresolvable external references]

## 11. Implementation Considerations

The deployed Catena-X connector provides the following integration points for use-case applications:

- **4 API Gateway endpoints:** Management API, DSP API, Data Plane API, Observability API
- **S3 bucket:** For data shared outbound to and received inbound from other Catena-X participants

Use-case applications integrate through these interfaces and should not access the connector's internal infrastructure directly.

Based on the requirements identified in this brief (APIs, data models, exchange patterns, notification flows), propose an AWS-based architecture that accelerates implementation. Catena-X standards are technology-agnostic — any compliant implementation is valid — but consider which AWS services best fit the specific needs of this use case.

---

**This brief covers everything needed to build a compliant implementation. All MUST requirements are non-negotiable. SHOULD requirements should be followed unless there is documented justification for deviation.**
```

After writing the file, tell the user:
> "The compliance brief has been written to `docs/compliance-brief-<use-case>.md`. This file contains the complete research output — all normative requirements, JSON schemas, example payloads, EDC configuration, and API specifications. A build-phase agent session can load this file to start implementation with full compliance context."

---

## Appendix A: URL Pattern Reference

### KIT Documentation
| Pattern | Example |
|---------|---------|
| KIT landing page | `https://eclipse-tractusx.github.io/docs-kits/category/<kit-name>-kit` |
| Adoption View | `https://eclipse-tractusx.github.io/docs-kits/kits/<kit-name>-kit/adoption-view/` |
| Development View | `https://eclipse-tractusx.github.io/docs-kits/kits/<kit-name>-kit/development-view/` |
| Architecture | `https://eclipse-tractusx.github.io/docs-kits/kits/<kit-name>-kit/development-view/architecture` |

### Catena-X Standards
| Pattern | Example |
|---------|---------|
| Standards overview | `https://catenax-ev.github.io/docs/standards/overview` |
| Individual standard | `https://catenax-ev.github.io/docs/standards/CX-XXXX-StandardName` |

**IMPORTANT:** Always use `/docs/standards/` (current release). NEVER use `/docs/next/standards/` — that path contains unreleased draft standards.

**URL slug pitfalls:** Standard URL slugs can contain typos or unexpected spellings in the original standard name (e.g., `PolicyConstrains` instead of `PolicyConstraints`). If a URL returns 404, fetch the standards overview page at `https://catenax-ev.github.io/docs/standards/overview` in rendered mode and scan the sidebar navigation for the standard number — the sidebar contains the exact URL for every published standard.

### Semantic Data Models

The base URL for all raw file access is `https://raw.githubusercontent.com/eclipse-tractusx/sldt-semantic-models/main/`. Append the paths below to this base.

| Pattern | Path (append to base URL) |
|---------|--------------------------|
| Model directory (browsable) | `https://github.com/eclipse-tractusx/sldt-semantic-models/tree/main/io.catenax.<model_name>` |
| Version directory (browsable) | `https://github.com/eclipse-tractusx/sldt-semantic-models/tree/main/io.catenax.<model_name>/<version>/` |
| Metadata | `io.catenax.<model_name>/<version>/metadata.json` |
| JSON Schema | `io.catenax.<model_name>/<version>/gen/<ModelName>-schema.json` |
| Example payload | `io.catenax.<model_name>/<version>/gen/<ModelName>.json` |
| OpenAPI fragment | `io.catenax.<model_name>/<version>/gen/<ModelName>.yml` |
| SAMM Turtle file | `io.catenax.<model_name>/<version>/<ModelName>.ttl` |

### Catena-X Namespaces
| Prefix | Namespace |
|--------|-----------|
| `cx-taxo` | `https://w3id.org/catenax/taxonomy#` |
| `cx-common` | `https://w3id.org/catenax/ontology/common#` |
| `dct` | `http://purl.org/dc/terms/` |
