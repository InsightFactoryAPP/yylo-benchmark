---
wiki_contract:
  line_limit: 180
  purpose: "Explain the stable Juno Benchmark operating boundary and evidence model."
  failure_mode_prevented: "Prevents evaluation work from becoming bespoke, mutable, or detached from canonical authorization."
  runtime_contract_enforced: "One opted-in engineering case expands into hash-bound attempts and immutable evidence."
  validation_gate: "juno-benchmark package test, typecheck, and build"
  owns:
    - "Benchmark concepts, boundaries, and operator sequence"
  does_not_own:
    - "Project-specific evaluation knowledge"
    - "Agent execution or canonical work records"
---

# Juno Benchmark overview

Juno Benchmark answers a narrow question: which model or agent system is the least
expensive option that resolves a category of real engineering work reliably enough?
Resolution is primary. Runtime, paid cost, invalid-run rate, and consistency remain
separate evidence; unavailable cost is never represented as zero.

## Boundaries

- Canonical work records authorize eligible cases and experiment lifecycle changes.
- Juno Code owns provider execution, sessions, process behavior, and raw usage evidence.
- Juno Benchmark owns case identity, isolated snapshots, attempts, grading, retained
  evidence, comparisons, and recommendation-only reports.
- Package pages provide stable guidance. Pages below `project/` are unlimited,
  project-owned knowledge and are never replaced by package updates.

## Trust model

Candidate source is exported from an exact Git tree into a fresh repository with
isolated Git objects. The first version trusts the same-user host filesystem and does
not claim container isolation. Candidates use a shadow work board and cannot mutate
the canonical controller.

## Operator sequence

1. Explicitly opt in a suitable engineering case and declare exact base inputs.
2. Lint the case, selected project wiki pages, grader profile, and isolation policy.
3. Produce and review a deterministic plan before any canonical mutation.
4. Run bounded attempts, retaining truthful session, patch, grader, cost, and runtime evidence.
5. Classify infrastructure-invalid outcomes separately from model failures.
6. Compare repeated valid attempts and publish recommendations, not automatic routing.
