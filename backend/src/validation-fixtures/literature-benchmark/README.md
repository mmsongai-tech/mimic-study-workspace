# Literature benchmark

40 study definitions extracted from published, open-access MIMIC-IV papers (4 per study type), used to score the
question-to-study pipeline: study type, variable mapping (concept, data domain, source table, and codes where the
paper reports them), method choice, and — once executed on the local archive — cohort size and effect direction.

## Provenance

- Every case cites its source paper (PMCID, DOI, URL). Case content is structured facts and paraphrase written for
  this benchmark; no paper text is reproduced. `question_zh` / `question_en` are our own phrasings.
- No patient-level data. Counts and estimates are the published aggregate values.
- Where a paper did not report a field, it is `null` and listed in `extraction.not_reported`. Where source tables
  were inferred rather than stated, `extraction.notes` says so.
- Extracted 2026-09-23 by automated literature agents and spot-checked against full text. Confidence per case is in
  `extraction.confidence` (11 high, 29 medium). Clinical review of the cases is still pending.

## Scoring caveats

- Most papers used MIMIC-IV v1.0–2.2; the local archive is 3.1, so N and estimates are compared with tolerance.
- Most papers do not list ICD codes or itemids; mapping is scored on concept, domain and table, and on codes only
  where reported (28 of 40 cases).
- `lit-em-01` needs MIMIC-IV-ECHO, which is not in the core archive: the expected platform verdict is
  "partially answerable".
