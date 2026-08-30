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

Candidate and judge packets include only declared evidence. A governed judge packet binds
versioned task requirements, actual rubric bytes, deterministic candidate truth, a bounded
transcript, and content-addressed required artifacts. It excludes candidate provider/model
identity. Scan packets and retained justifications for secrets, credentials, personal data,
model identity, and prohibited production content before retention. Redaction failure makes
the judgement invalid; it never becomes a rejection. Production access needs independent
explicit authorization and is not implied by case eligibility.

## Immutable derivation

Never rewrite an attempt object. Every governed judgement retains a versioned terminal
envelope with requested/observed provider, model and Juno version, one session, timestamps,
runtime, cost completeness, exit status, strict verdict, and a hash-bound redacted factual
justification. Regrading, rejudging, comparison, and investigation append derived objects
that name source hashes and versions. Doctor verifies semantic proof as well as hashes;
legacy hash-only judgements remain readable but are reported judge-invalid until rejudged.

Retention deletion is deferred. Until an independently reviewed policy exists, preserve
canonical evidence and keep the registry private. Do not copy large logs into canonical
work Markdown; store compact hash-verified indexes there instead.
