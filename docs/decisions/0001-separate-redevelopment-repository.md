# 0001: Separate the redevelopment repository

Status: accepted  
Date: 2026-08-28

## Context

The existing MIMIC application contains uncommitted product work, local data, generated artifacts, historical experiments, and the service used for the current demonstration. Refactoring it in place would mix cleanup with operational risk and make public-history review harder.

## Decision

Use this repository as the future public codebase. Treat the existing application as a read-only migration source until a file-level inventory, safety check, and representative vertical slice pass acceptance.

Migration copies only reviewed source. It does not copy Git history, local runtime state, data, caches, archives, or generated delivery material by default.

## Consequences

- The current 3002 demonstration remains isolated from redevelopment work.
- Product code is temporarily duplicated only when a reviewed slice enters this repository.
- Historical code without current product value can be excluded without rewriting the old working repository.
- The project must maintain an explicit migration inventory until the transition is complete.

## Review trigger

Review this decision after the first vertical slice reaches L3 and the new repository can run independently.
