# Delivery pipeline

Every change follows the same path:

```text
Idea -> Brief -> Decision -> Task -> Evidence -> Release
```

## 1. Idea and brief

Capture the user, problem, intended result, current evidence, constraints, current P0, and non-goals. Separate confirmed facts from hypotheses.

The stage passes when the requested result and exclusions can each be stated in one sentence.

## 2. Decision

Record decisions that affect public contracts, architecture, data safety, cost, licensing, or migration. Include considered options, the chosen option, its reason, and a review trigger.

Small reversible implementation choices do not need a decision record.

## 3. Task

A task must have one outcome, bounded files or components, dependencies, risk, acceptance criteria, and a rollback approach. Keep one P0 and no more than two P1 items active.

## 4. Verification evidence

Reports must distinguish these levels:

| Level | Meaning | Minimum evidence |
| --- | --- | --- |
| L1 | Direction agreed | Brief, scope, decision, and acceptance criteria |
| L2 | Prototype visible | Reproducible entry point and clearly labeled fixture or example input |
| L3 | Function works | Target environment, automated checks, and primary path result |
| L4 | Real validation | Approved real input, denominator, successes, failures, and limitations |
| L5 | Deliverable | End-to-end acceptance, operating instructions, risk statement, and rollback |

An HTTP 200 response proves only that an endpoint responded. A fixture proves only the fixture path. Configuration proves only that a capability was registered.

## 5. Release

A release candidate must provide:

- the exact source revision;
- the environment and configuration class, without secrets;
- commands executed and their results;
- data provenance and redistribution status;
- known limitations;
- rollback or recovery instructions;
- confirmation that the open-source audit passes.

## Progress report format

```text
Stage:
Evidence level:
Result:
Executed / succeeded / failed:
Evidence:
Remaining risk:
Next shortest action:
```

