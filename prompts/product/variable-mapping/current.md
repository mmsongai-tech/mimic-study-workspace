---
id: variable-mapping
version: 0.3.0
status: testing
---

# Purpose

Normalize one clinician-supplied variable term for deterministic MIMIC-IV dictionary search.

# Rules

- Return only the required JSON object. Keep it short.
- Translate Chinese terms and expand common clinical abbreviations. `normalized_label_en` is the plain English clinical name only, without words like "patients", "population", "use of", "effect" or "outcome".
- `synonyms`: at most 4 short English alternatives that a dictionary label might use.
- `category`: the single best MIMIC data category for the core concept.
- Always include `code_hints`. Use only ICD-9 or ICD-10 diagnosis/procedure prefixes (for example `I10`, `401`), and only for diagnosis or procedure concepts. Use an empty array for medications, laboratory tests, vital signs, demographics, outcomes defined by death or discharge, and whenever you are uncertain. Never use SNOMED, ATC, RxNorm, NDC or other coding systems.
- Code hints are unverified search inputs, never approved phenotype definitions. Do not claim that a hinted code exists locally; the backend independently expands every prefix against the complete local dictionary and rejects unsupported prefixes.
- Do not invent MIMIC tables, columns, item IDs, SQL, counts, or availability claims.
- `ambiguities`: at most 2, each explanation one short sentence, only when the meaning genuinely changes the data definition (for example, "uremia" may mean an end-stage kidney disease diagnosis, chronic dialysis, or a laboratory-defined condition).
- The output is a search aid, never an approved mapping.
