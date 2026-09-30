# 1. Record architecture decisions

Date: 2026-09-30

## Status
Accepted

## Context
The design contains decisions a later reader cannot reconstruct from code alone — why money is
BigInt kobo, why the app never computes breach status, why rules are snapshotted per account.
Without a record, agents and humans either re-litigate them or silently diverge.

## Decision
Keep `Architecture-Essential.md` as the source of the non-negotiable decisions (D1–D13). Record
each *new or changed* decision here as a short ADR: context, decision, consequences. When code
conflicts with `Architecture-Essential.md`, the doc wins; the fix is an ADR, not a quiet edit.

## Consequences
- Decisions get a date and a rationale, so stale ones are visible instead of load-bearing.
- Changing a hard rule costs one small doc, which is deliberate.
- `Architecture-Essential.md` must be updated in the same PR as the ADR that supersedes a
  decision in it.
