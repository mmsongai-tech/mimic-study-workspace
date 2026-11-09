# Open-source gates

Publishing is blocked until every required gate passes on the exact candidate revision.

| Gate | Required evidence | Failure action |
| --- | --- | --- |
| Migration policy | Every migrated source file appears in the allowlist and not the denylist | Remove the file or complete its review and approval |
| Secrets | Current tree and Git history scan; manual review of connection scripts | Rotate exposed credentials, remove them from history, and repeat the scan |
| Clinical data | Patient-level, sensitive-path, database, archive, and restricted-derivative scan | Remove the material and review whether exposure occurred |
| Provenance | Source and redistribution status for fixtures, images, fonts, papers, templates, and generated assets | Replace, attribute under compatible terms, or exclude |
| Dependencies | Locked dependency inventory, license report, and software bill of materials | Replace or resolve incompatible or unknown dependencies |
| Contracts | Public schemas, producers, consumers, adapters, documentation, and contract tests agree | Fix the change set before merge |
| Verification | Type checks, lint, unit tests, contract tests, build, and representative smoke test as applicable | Report the exact failure; do not upgrade evidence level |
| Claims | Fixture, cache, historical result, approved real execution, and end-to-end evidence are labeled separately | Correct the artifact and all dependent copy |
| Reproduction | Clean checkout instructions work without private paths or undeclared local services | Fix setup or document an explicit optional integration |
| Release | Revision, commands, results, limitations, rollback, and data boundary are recorded | Do not publish a release |

## History matters

`.gitignore` prevents new accidental additions but does not make existing history safe. Before the first public push, scan both the candidate tree and every reachable commit. If a secret or restricted record entered history, deleting the working-tree file is insufficient.

## Evidence labels

Every analysis artifact exposes exactly one source class:

```text
synthetic_fixture
historical_snapshot
approved_aggregate_cache
approved_current_execution
```

The artifact separately records its validation level. Source class and validation level cannot be inferred from the filename or UI route.

## First-commit gate

The first commit may contain only the reviewed governance skeleton. Product code remains blocked until the first-slice allowlist is approved. Committing and publishing are separate actions; a local commit does not authorize a remote push.
