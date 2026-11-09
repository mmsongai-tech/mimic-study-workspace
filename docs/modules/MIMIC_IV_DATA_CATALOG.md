# MIMIC-IV data catalog

Status: implemented and independently verified; online refresh evidence and offline snapshot evidence are reported separately.

## Module card

Problem and user value: free-form research questions need a safe way to determine which MIMIC-IV relations and fields may support a proposed study before any patient data is read.

Primary responsibility: retrieve and validate relation and column metadata for `mimiciv_hosp`, `mimiciv_icu`, and `mimiciv_derived` through a named PostgreSQL service and a read-only transaction.

The module also owns an integrity-checked local catalog snapshot. A live inspection explicitly refreshes the snapshot atomically. Normal development can load the snapshot without starting a tunnel or contacting PostgreSQL. The snapshot is local-only and ignored by Git.

Non-responsibilities: credentials, patient rows, cohort construction, unrestricted SQL, clinical concept semantics, statistical-method selection, and model context.

Public input: one typed PostgreSQL service configuration. Public output: a versioned catalog of schemas, relations, field names, data types, nullability, counts, and inspection time. Public errors remain safe database configuration, client, connection, or response errors.

Security boundary: `psql` receives only a service name through its environment. The fixed query reads `information_schema`; credentials and database contents never enter process arguments, logs, prompts, UI state, or run evidence.

Independent evidence: `backend/src/clinical-database/tests/clinical-database-catalog.test.ts`. Connection evidence requires the exact approved `mimic-iv` service and a passing database preflight before catalog inspection.

Snapshot evidence: `backend/src/clinical-database/tests/clinical-database-catalog-snapshot.test.ts`. A missing, malformed, count-inconsistent, or integrity-mismatched snapshot fails closed. The snapshot contains schema metadata only—never patient rows, credentials, connection strings, query results, or database files.

Commands:

```bash
# Explicit online refresh: preflight, inspect the full catalog once, and atomically replace the local snapshot.
npm run inspect:database-catalog

# Offline use: read and integrity-check the existing local snapshot without connecting to PostgreSQL.
npm run show:database-catalog
```

Rollback boundary: remove the catalog client/service without changing research design, statistical execution, run evidence, or the frontend. A future native PostgreSQL adapter may replace the `psql` client behind the same catalog-source contract.
