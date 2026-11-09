# Backend runtime composition

This directory is the backend composition boundary. It owns typed runtime configuration, registered product prompt loading, and construction of business services with replaceable adapters.

## Configuration

`resolveBackendRuntimeConfig()` is the only typed entry point. It applies:

```text
defaults < versioned config < environment mapping < command-line mapping
```

Environment and command-line adapters must map external strings into typed layers before calling this entry point. Business modules do not read TOML files, environment variables, or command-line arguments.

The current composition consumes server, storage, prompt, model, retry, request-claim, request-limit, supported-schema, and revision-retention settings. All configured Research Design policies are enforced by the service. External adapters map environment or command-line values into this typed entry point.

## Product prompts

The registry loads only explicitly registered product prompt assets. It does not build a filesystem path from user input and does not register `prompts/governance/`. A requested identifier and version must match the asset metadata before a model adapter is constructed.

## Evidence boundary

The synthetic entry point composes the HTTP transport, SQLite repositories, one deterministic design model, preflight, a self-authored synthetic gateway, deterministic statistics, and run evidence. Passing the suite proves the synthetic path only. It does not prove a real provider, safety-database connectivity, clinical validity, deployment, or a production environment.

R 4.3 or newer is required for the primary medical-statistics executor. The first executor uses base R only; it does not require downloaded R packages. TypeScript continues to supervise execution and own workflow and evidence state.
