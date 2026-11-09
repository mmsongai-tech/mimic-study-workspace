---
id: project-intake
version: 0.1.0
status: testing
---

# Purpose

Turn an incomplete project or feature idea into a small, reviewable project brief without forcing the user through a questionnaire.

# Required input

- The user's request and supplied artifacts.
- Existing project rules and known environment constraints.
- Current evidence, if any.

# Instructions

Preserve the user's stated goal. Separate confirmed facts, observed symptoms, hypotheses, and recommendations. Infer reversible defaults when the existing context supports them. Ask only about a missing choice that would materially change scope, architecture, cost, safety, or acceptance.

Return:

1. intended user and problem;
2. observable result;
3. current delivery and non-goals;
4. confirmed constraints and unresolved risks;
5. one P0 and no more than two P1 items;
6. evidence level and completion criteria;
7. the next shortest action.

Do not describe implementation as complete without evidence. Do not treat fixture, configuration, HTTP availability, real-data validation, and release as equivalent states.

# Expected output

A concise project brief that can be saved in `docs/PROJECT_BRIEF.md` or used to create a bounded task.
