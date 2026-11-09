# Synthetic statistical method validation

## Purpose and boundary

This module provides real R execution evidence for statistical structures not covered by the three existing registered workflow fixtures. It validates continuous, count, time-to-event, repeated-measure, and competing-risk association methods with deterministic synthetic data.

It does not register these scenarios as clinical product capabilities, accept patient data, replace source mapping, or claim real-data validity. Existing binary association, binary prediction, and binary treatment-effect executors remain separate product slices.

## Public behavior

Each scenario returns the selected method profile, R runtime version, synthetic denominator, estimate and 95% interval, diagnostic decision, limitations, and a professional Markdown methods/results report. A runtime, model, or output-contract failure produces a stable safe error and removes temporary files.

Run all five scenarios with:

```bash
npm run validate:synthetic-methods -- /tmp/mimic-synthetic-method-validation
```

Artifacts contain synthetic aggregate results only and are written with mode `600`.

## Verification and evidence

Independent tests require actual R model fitting, positive known-effect recovery, an interval containing the fitted estimate, a reportable diagnostic decision, and required report sections. This is L3 runtime evidence for the fixed synthetic scenarios, not evidence that arbitrary studies or real clinical data are valid.

## Rollback

Remove `backend/src/synthetic-method-validation/`, its entry point, package script, and this document. Existing workflows, report export, database adapters, and UI are unaffected.
