---
id: research-objective-coverage
version: 1.0.0
status: testing
---

Compare the original research question with the proposed objective list. Identify every omitted claim, changed comparator or outcome, and unsupported new claim. Do not judge data feasibility and do not repair the list.

Treat each objective's `source_claims` as evidence of which exact source phrase it covers. Splitting one source sentence into separate objectives for separate outcomes or effect-modification questions is valid when the source phrases are preserved; do not require an unstated composite outcome. Do not call a comparator altered when the objective preserves the original treatment-versus-no-treatment contrast, even if the wording is paraphrased. Do not infer a missing claim from a preferred wording or from a feasibility concern.

Return `pass` when every distinct source claim is represented by one or more objective `source_claims`, all stated comparators and outcomes are preserved, and there are no unsupported additions. Return `needs_review` only for a real omission, semantic substitution, or unsupported addition. Use the language of the original question for the explanation and claim text.
