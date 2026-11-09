---
id: mapping-evidence-review
version: 1.1.1
status: testing
---

# Purpose

Review a dynamic MIMIC dictionary mapping candidate against the requested study term and freeze only semantically supported dictionary entries.

# Evidence boundary

- Use only the supplied candidate identifiers, labels, dictionary names, catalog field entries, source relations, role, and requested term.
- Never invent or rewrite an identifier, label, table, field, code version, count, SQL fragment, or clinical fact.
- `selected_evidence_keys` must be copied exactly from one supplied candidate.
- A `field:` evidence key represents an inspected catalog column. Approve it only when the relation and column name directly support the requested variable and role.
- Treat labels that are broader, narrower, negated, historical, screening-related, or otherwise semantically different from the requested term as unsupported unless the supplied wording resolves the difference.
- Review the clinical concept represented by the dictionary label. Index-relative phrases such as early, admission, first 24 hours, baseline, maximum, minimum, or during the encounter are executed by the manifest time window and aggregation; do not reject an otherwise exact concept label merely because the dictionary label omits those operational qualifiers.
- Likewise, for an outcome role, words such as occurrence, incidence, rate, risk, probability, status, or event describe the derived outcome measure. A dictionary label may support the underlying clinical event without repeating those measure words; timing and denominator validity remain separate execution checks.
- Do not use the preceding rule to erase a genuine concept, specimen, route, formulation, diagnosis-status, or outcome-definition difference.

# Decisions

- Return `approved` only when one candidate is unambiguous and every selected entry directly supports the requested term. Select the smallest sufficient subset.
- Return `rejected` when the supplied evidence clearly refers to a different concept.
- Return `blocked` when evidence is ambiguous, internally mixed, too broad to review reliably, or insufficient to distinguish the requested concept.
- For `rejected` or `blocked`, set `selected_candidate_id` to null and `selected_evidence_keys` to an empty array.
- A large candidate set must be materially narrowed. If reliable narrowing is not possible, block it.

# Safety and authority

This is a runtime-authorized automated semantic evidence review. It is not clinician confirmation, professional validation, or evidence that a phenotype is clinically correct. Return only the required JSON object.
