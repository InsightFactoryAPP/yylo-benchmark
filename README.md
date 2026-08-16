# Juno Benchmark

Private, independent Kanban-SOT longitudinal evaluation package. Juno Benchmark owns
case validation, isolated snapshots, shadow boards, immutable evidence, execution
reconciliation, recovery, reports, and bounded investigations. It invokes Juno Code
for agent sessions and uses only the public Juno Kanban JSON/receipt CLI contract.

```bash
npm install
npm test
npm run typecheck
npm run build
node dist/bin.js init
node dist/bin.js case lint TASK_ID
node dist/bin.js plan --task TASK_ID --models :mini,:sol --attempts 3 --output plan.json
JUNO_BENCHMARK_REGISTRY=/private/path node dist/bin.js run --plan plan.json
JUNO_BENCHMARK_REGISTRY=/private/path node dist/bin.js regrade --plan plan.json
JUNO_BENCHMARK_REGISTRY=/private/path node dist/bin.js doctor EXPERIMENT_TASK_ID
JUNO_BENCHMARK_REGISTRY=/private/path node dist/bin.js report --task TASK_ID
```

`yy benchmark ...` is a transparent delegate to an independently installed compatible
`juno-benchmark` executable. The standalone CLI remains canonical.

A case must carry the `benchmark-case` tag and valid `fields.benchmark` metadata. Its
task body is the candidate prompt. Planning is read-only and content-addressed. A
canonical run creates one related experiment task; `--no-record` additionally requires
`--non-canonical-scope fixture|local` and is only for non-canonical fixture work.

Set `JUNO_BENCHMARK_REGISTRY` to a private controller-resolved local registry before
commands that retain or read evidence. `JUNO_BENCHMARK_WORK_ROOT` may select retained
attempt workspaces. By default the public Kanban adapter discovers
`.juno_task/scripts/kanban.sh`; configuration may select another public CLI executable.
Alias selectors such as `:mini` must have an exact `provider/model` entry in the
configuration's `model_aliases` map. Planning hashes both the selector and exact
identity, and execution dispatches only the exact identity so alias drift fails closed.

Execution consumes only the public `juno_execution_envelope.v1` emitted by
`yy pi --execution-envelope`. Provider and model are separately observed and must
normalize to the exact planned identity; candidate output cannot declare its own
identity or resolution. Cost retains complete, partial, unavailable, not-applicable,
and genuine-zero semantics.

Each case's `grader_profile` must select a configured `grader_profiles` entry bound to
an executable SHA-256, grader ID, and version. Required grader input, output, result,
and integrity-linked receipt artifacts determine resolution. A missing, failed,
removed, or tampered grader fails closed. The public `regradeExperiment` API consumes
retained attempt/candidate/patch evidence and can append a new grading generation
without accepting or rerunning a candidate runner.

`init` installs the five package-managed benchmark wiki pages with checksum/conflict
semantics. Pages under `.juno_task/wiki/juno-benchmark/project/` are project-owned and
are never overwritten. V1 provides isolated Git objects in a fresh repository but truthfully treats the
same-user host filesystem as trusted; it does not claim container or hostile-host
isolation. Candidate execution receives a snapshot-local HOME/XDG and a sanitized
environment with credential and canonical-controller routing variables removed.

## Authenticated launcher boundary

Authenticated execution is available only through one reviewed launcher boundary. Set
all of `JUNO_BENCHMARK_AUTH_LAUNCHER`, `JUNO_BENCHMARK_AUTH_LAUNCHER_SHA256`, and
`JUNO_BENCHMARK_AUTH_PROVIDER`, plus exactly one of `JUNO_BENCHMARK_AUTH_ENV` or
`JUNO_BENCHMARK_AUTH_FILE`. Environment transports are provider-allowlisted:
`OPENAI_API_KEY` for `openai`, `OPENAI_CODEX_TOKEN` for the distinct `openai-codex`
identity, `ANTHROPIC_API_KEY` for `anthropic`, `GEMINI_API_KEY`/`GOOGLE_API_KEY` for
Google identities, and `ZAI_API_KEY` for `zai`. Credentials must be 16–65536 ASCII
bytes in the RFC 3986 unreserved provider-token alphabet `A-Z a-z 0-9 . _ ~ -`; this
covers the providers' documented API-key, base64url, and JWT-style tokens while excluding
control and JSON-special bytes that could create a reversibly escaped leak. Token files
must be absolute, canonical, private, owner-matched regular files outside the candidate
snapshot. Relative paths, symlinks, cross-provider transports, ambiguous sources,
unsupported providers, mutable launchers, and any mismatch among launcher provider,
attempt provider, and model prefix fail before the durable dispatch marker.

The immutable launcher protocol permits only `probe` and `launch`. For `launch`, the
secret arrives on anonymous fd 3 and the prompt on fd 4; neither appears in argv,
candidate environment, HOME/XDG, snapshots, or receipts. A conforming reviewed
launcher consumes and closes both descriptors before creating any candidate tool and
must sanitize its descendants. Raw, hexadecimal, base64, base64url, URL-encoded, and
JSON-serialized secret output or prompt content is rejected rather than retained. The
shipped tests use only a synthetic zero-cost launcher. Configuring this boundary is
not authority for paid dispatch, and the package does not ship provider credentials.

## Deterministic release readiness and D0 exclusion

`juno-benchmark release-readiness --input measured-identities.json` emits the canonical
`juno_benchmark_release_readiness.v1` receipt. The path-free input binds the clean Git
commit/tree, both package versions, source/dist/npm-tarball hashes, and standalone plus
`yy benchmark` identities from both built and tarball-installed CLIs. It must also carry
exactly one coverage result and one credential/leak-scan result produced by the fixed,
stdin-closed commands in `RELEASE_VERIFICATION_COMMANDS`. Each bounded execution binds
the unchanged source tree, exact command and timeout, zero exit result, measured output,
stdout/stderr log digests, and canonical result/evidence hashes. Coverage is derived
from 14 executed case results. Leakage is derived from six executed, bounded synthetic
artifacts—one each for private registry, credentials, candidate HOME/XDG, controller
route, host path, and candidate Git metadata—with source/command bindings, observed
rejection truth, output/log hashes, per-check result hashes, and one aggregate bundle
hash. Both result sets must be complete and pass; missing, failed, duplicated, stale,
command/source mismatched, altered, or hash-mismatched evidence is rejected.
`juno-code/scripts/verify-benchmark-release-artifacts.mjs` executes these commands
against staged tracked sources and packed artifacts; the receipt never turns
caller-supplied booleans into readiness claims.

The generator fails closed on an incomplete matrix, version drift, private-registry/auth
values, candidate HOME/XDG values, controller routes, host paths, and candidate-controlled
Git metadata. Bound deterministic fixtures cover Sol, Mini, Luna, and `zai/glm-5.2`;
success/failure; missing, genuine-zero, and positive cost; patch evidence; missing and
tampered grader receipts; and regrading retained evidence without candidate execution.

This is an **offline D0** receipt. It excludes live workflow execution, paid frontier
judging, and actual Sol/Mini/Luna/GLM dispatch. The Daily Ops contract now provides a
separate synthetic-only gate: one strict JSON-compatible YAML source whose byte hash
and executable step/scoring/prompt/resource semantics are inseparable, dated variable
bindings, typed strictly sequential shared-resource evidence, trusted-boundary redaction
evidence, outer/nested session economics, integrity-bound atomically persisted recovery
checkpoints, explicit candidate-failure versus harness-invalid step truth, and governed
rejudge over retained candidate truth that fails closed unless the caller supplies the
original `receipt_hash` from a trusted immutable ledger (never from the mutable receipt
being rejudged). Its Aug. 12 Sol,
`:mini` (`openai-codex/gpt-5.6-terra`), Luna, and GLM plan is explicitly
`offline_unapproved`, dispatch-disabled, and estimate-only. Neither
that plan nor release readiness grants the separately reviewed production/spend
authority required by `D0tTNr`.

The exact next-RC gate is: start from the receipt's clean commit/tree in the dedicated
linked integration-owner worktree on branch `juno-mono-002`; rerun package tests,
typecheck, builds, packs, packed delegate verification, Real-Git and fake recovery
checks; regenerate the identical receipt from the resulting tarballs; independently
review that receipt and tarball hashes; then, and only with explicit owner release and
registry authority, invoke the repository's guarded Juno Code release script described
in the root operator instructions and publish the reviewed benchmark tarball under the
next/RC tag. Any tree, version, tarball hash, CLI identity, review, authority, or clean
state mismatch restarts the gate. This project does not run that release or publication
as part of readiness validation.
