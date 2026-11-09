# Held-out literature benchmark / 留出文献测试集

34 questions taken from published MIMIC-IV papers (2022 or later), written down and committed **before any of them was run**.
The 20 questions used earlier (`.local/literature-test/benchmark.json`) were used to fix the platform and are not held out; these 34 are not to be used to change the platform.
Rule: if a question fails, the failure is reported; the platform is changed only for a class of failures seen across several questions, and only after the result is written down.
Reference numbers come from abstracts or full texts (see `evidence_quality`); they are targets for direction and rough size, not exact reproduction (designs differ). No patient-level data.
