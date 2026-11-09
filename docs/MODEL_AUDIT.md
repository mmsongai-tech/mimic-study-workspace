# Model audit view

The separate, read-only developer page at `/developer/audit` keeps operational evidence out of the clinical research workflow.

`GET /v1/model-audit?limit=50` returns only provider/model/stage, prompt and Schema ID/version/hash, JSON/Schema/business validation state, structured-output mode (`json_schema`, `json_object`, or `prompt_contract`), repair count, latency, safe failure class, and available output/StudySpec/manifest/method/report hashes.

The transport applies an allow-list projection. It never returns the research question, prompt text, model response, API key, credentials, patient data, local archive paths, or patient-derived validation values. `SqliteModelAuditRepository` applies the same projection before persistence, so disallowed values never enter the audit table. The workspace reads that table through `ModelAuditQueryService`; HTTP remains read-only. If no reader is configured, the endpoint returns `503 MODEL_AUDIT_UNAVAILABLE` rather than fabricating evidence.

The research-objective sweep and multi-objective local-run entry point are connected producers for successful and failed model calls. Multi-objective runs append the StudySpec, manifest, method, and report integrity hashes as those immutable artifacts become available; the audit module does not inspect clinical data or infer missing hashes.
