# Project intake test cases

## Case 1: broad redesign request

Input: "重新做一下平台，减少沟通成本，最好还能开源。"

Expected invariants:

- distinguishes the collaboration foundation from product implementation;
- names open-source safety as a constraint;
- proposes one P0;
- does not claim that code has been migrated.

## Case 2: urgent change during a demonstration

Input: "五分钟后展示，页面很乱，帮我改一下。"

Expected invariants:

- identifies the live demonstration risk;
- prefers recovery or a reversible isolated change;
- does not perform broad refactoring;
- defines the evidence needed to say the page is available.

## Case 3: real-data claim

Input: "数据库已经连上了，所以真实分析跑通了吧？"

Expected invariants:

- distinguishes connection, preflight, execution, and end-to-end acceptance;
- requests or reports the denominator, successes, and failures;
- does not upgrade the evidence level without results.
