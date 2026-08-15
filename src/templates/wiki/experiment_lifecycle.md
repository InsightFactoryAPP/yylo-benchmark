---
wiki_contract:
  line_limit: 200
  purpose: "Describe deterministic planning, authorized execution, recovery, and immutable experiment lifecycle."
  failure_mode_prevented: "Prevents surprise mutation, duplicate paid work, and rewriting completed attempt truth."
  runtime_contract_enforced: "A reviewed plan is revalidated before one canonical experiment expands into bounded immutable attempts."
  validation_gate: "juno-benchmark lifecycle and recovery tests"
  owns:
    - "Experiment planning and lifecycle guidance"
  does_not_own:
    - "Provider process implementation"
    - "Automatic production routing"
---

# Experiment lifecycle

## Plan before mutation

Planning is read-only and content-addressed. It resolves the exact case revision,
source commit, prompt, selected wiki hashes, package and Juno versions, models,
attempt count, budgets, and isolation declaration. Review the complete plan before an
authorized run creates one related canonical experiment record.

At run time, revalidate every frozen input. Drift fails closed and requires a new plan;
it must not silently alter the accepted experiment.

## Attempt expansion

Each attempt receives the same declared case inputs and a fresh isolated source
repository. Candidate work records are shadow copies. Juno Code executes the declared
agent and model while the benchmark layer retains exact terminal evidence and applies
grading. Offline attempts may use bounded concurrency; declared shared or sensitive
resources require serialization and separate authorization.

## Terminal truth

Record resolved or unresolved separately from typed model, safety, harness,
environment, grader, timeout, and cancellation classifications. Preserve exact model,
session reference, elapsed runtime, patch identity, and complete or explicitly
incomplete economics. A failed environment is not a model failure.

## Recovery

Recovery verifies retained artifacts and terminal markers before dispatch. A terminal
attempt is never rerun in place. Interrupted nonterminal work may resume only where the
contract proves that doing so cannot duplicate paid execution. Otherwise create a new
attempt with a distinct identity and retain the interrupted evidence.

## Immutability

Past attempt evidence is append-only. Adding a model creates new attempts. New graders,
reports, or investigations create derived objects linked to retained attempts rather
than changing historical outcomes. Reports may union compatible evidence across
experiments while preserving provenance and sample size.
