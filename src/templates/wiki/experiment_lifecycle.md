---
wiki_contract:
  line_limit: 200
  purpose: "Describe deterministic planning, authorized execution, recovery, and immutable experiment lifecycle."
  failure_mode_prevented: "Prevents surprise mutation, duplicate paid work, and rewriting completed attempt truth."
  runtime_contract_enforced: "A reviewed plan is revalidated before one canonical experiment expands into bounded immutable attempts."
  validation_gate: "yylo-benchmark lifecycle and recovery tests"
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

## Project-owned workflows

Use generic `plan --workflow`, `run`, `recover`, and `rejudge` commands. The tracked
Workflow Runner YAML stays the sole prompt source. A mandatory policy sidecar binds
stable step/scoring IDs, typed resources, side effects, limits, redaction, recovery,
governed judge, and estimates. Model overlays modify only canonical `yy pi` argument arrays.
Workflow commands must be explicit argv: canonical `yy pi` is the model route, direct `echo`
and `printf` are the complete ordinary route, and scalar, shell, interpreter, wrapper, or
other executable forms are rejected rather than parsed.

Workflow cost is observational, not authorization. Plans contain no spend grant, ceiling, or
reservation. Candidate and judge operations receive immutable identity-bound requests through
the hash-pinned module selected by `YYLO_BENCHMARK_WORKFLOW_BOUNDARY` and
`YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256`. That module owns credentials and implements the
`juno_benchmark_workflow_process_boundary.v1` probe/preflight/dispatch/reconcile/resume/judge
protocol. Complete and partial USD evidence is retained when available; unavailable and
not-applicable cost remains explicit null evidence and does not invalidate an otherwise valid
run. Dry-run never loads the module, reports zero dispatch, and verifies source/policy/model/config
hashes. Recovery reconciles durable intent before resume; ambiguous effects are manual. Rejudge
persists identity-bound intent before judge dispatch, consumes retained blinded candidate truth,
and cannot rerun a candidate. It dispatches only eligible missing or judge-invalid work; a valid
terminal verdict and a candidate harness failure are both reused without judge redispatch.

Pin historical acceptance by exact Git commit, raw and semantic YAML hashes, and named
step IDs rather than positions. A detached checkout is valid. Keep expected identities
and policy metadata outside the product prompt source so current workflow growth cannot
silently redefine the historical suite.

## Attempt expansion

Each attempt receives the same declared case inputs and a fresh isolated source
repository. Candidate work records are shadow copies. YYLO executes the declared
agent and model while the benchmark layer retains exact terminal evidence and applies
grading. Offline attempts may use bounded concurrency; declared shared or sensitive
resources require serialization and separate authorization.

## Terminal truth

Record candidate outcome, candidate-harness validity, judge validity, and quality verdict
separately. Governed judge acceptance/rejection is valid only with an exact identity/session
envelope and retained justification. Provider non-dispatch, timeout, nonzero exit, malformed
output, missing strict verdict, missing task/rubric/artifacts, identity drift, or redaction failure
is typed judge-invalid evidence and leaves quality unknown. A failed environment or judge
harness is not a candidate/model failure.

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
