---
wiki_contract:
  line_limit: 200
  purpose: "Define truthful benchmark telemetry, immutable artifacts, privacy, and retention boundaries."
  failure_mode_prevented: "Prevents missing economics, mutable evidence, sensitive leakage, and unverifiable references."
  runtime_contract_enforced: "Every retained object is content-addressed and every attempt reports explicit evidence completeness."
  validation_gate: "yylo-benchmark registry, telemetry, privacy, and doctor tests"
  owns:
    - "Benchmark telemetry and retention guidance"
  does_not_own:
    - "YYLO raw session capture"
    - "Retention deletion policy"
---

# Telemetry and retention

Benchmark evidence lives in a private content-addressed registry resolved by trusted
configuration, not in a product worktree or a session-continuity file. Objects are
write-once, mode-private, and verified against SHA-256 before use. Experiment manifests
refer to objects by semantic role rather than trusting filenames.

## Minimum attempt evidence

Retain case and experiment identity, exact agent/provider/model and package versions,
session topology, start and end boundaries, elapsed runtime, outcome classification,
and hashes for inputs, snapshot, patch or tree, graders, transcript reference, and
terminal evidence.

Cost has both a value and a completeness state. Distinguish complete, partial,
unavailable, and not-applicable evidence. A genuine zero is valid only when direct
structured evidence proves it; missing cost is not zero.

## Privacy and safety

Candidate and judge packets include only declared evidence. Scan outputs for secrets,
credentials, personal data, and prohibited production content before retention or
analysis. Prefer normalized outcomes, patches, grader receipts, economics, and bounded
transcript references over complete transcripts. Production access needs independent
explicit authorization and is not implied by case eligibility.

## Immutable derivation

Never rewrite an attempt object. Regrading, comparison, and investigation produce new
objects that name their source hashes and tool or prompt versions. Doctor operations
verify object hashes, manifest references, session reconciliation, and completeness;
they diagnose but do not repair history silently.

Retention deletion is deferred. Until an independently reviewed policy exists, preserve
canonical evidence and keep the registry private. Do not copy large logs into canonical
work Markdown; store compact hash-verified indexes there instead.
