# Workspace resilience

## Availability contract

- `GET /health/live` reports whether the local HTTP process is serving requests. Optional dependency degradation never changes this endpoint from `200` while the process is alive.
- `GET /health/ready` reports capability-level readiness. Router, statistical runtime, report runtime, database, and generated-analysis states are independent of static workspace availability.
- Router failures are normalized by stage and never expose credentials or full provider responses.
- API failures return safe JSON errors and do not terminate the HTTP server.
- Static assets are served by the local application and do not depend on Router, R, Python, or a database request.

## Resilient local launcher

```bash
npm run start:resilient -- --database /tmp/mimic-research-agent-platform.sqlite --port 3000
```

The launcher starts the Router-backed local workspace even when no Router key is configured. If the Node process exits unexpectedly, it restarts with bounded exponential delay. `SIGINT` or `SIGTERM` stops the child and exits without restarting.

This is a local-development recovery boundary, not a production process manager. Production deployment should use the platform's supervised service mechanism and health probes.

## Failure ownership

- Failure before the server listens: application composition or local storage startup.
- Page live but readiness degraded: the named optional capability owns the failure.
- Static asset failure: workspace asset packaging.
- API request failure: the domain error code identifies design, analysis, evidence, or report ownership.
- Repeated process exit: inspect the local terminal or supervised service logs; secrets and patient data must not be logged.

## Verification and rollback

Run `zsh -n scripts/start-resilient-workspace.zsh`, the runtime status tests, and real HTTP lifecycle tests. Rollback removes the launcher, package script, and this document without changing the application server or UI.
