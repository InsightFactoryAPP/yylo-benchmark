# YYLO Benchmark

YYLO Benchmark is the longitudinal evaluation and immutable-evidence system for agent runs. It invokes [YYLO](https://github.com/yylo-dev/yylo), the AI coding-agent orchestration CLI, and uses [YYLO Ledger](https://github.com/yylo-dev/yylo-ledger), the Git-native task and workflow ledger, through its public JSON/receipt CLI contract.

The private, independent package owns case validation, isolated snapshots, shadow
boards, execution reconciliation, recovery, reports, and bounded investigations.

```bash
npm install
npm test
npm run typecheck
npm run build
node dist/bin.js init
node dist/bin.js case lint TASK_ID
node dist/bin.js plan --task TASK_ID --models :mini,:sol --attempts 3 --output plan.json
YYLO_BENCHMARK_REGISTRY=/private/path node dist/bin.js run --plan plan.json
YYLO_BENCHMARK_REGISTRY=/private/path node dist/bin.js regrade --plan plan.json
YYLO_BENCHMARK_REGISTRY=/private/path node dist/bin.js doctor EXPERIMENT_TASK_ID
YYLO_BENCHMARK_REGISTRY=/private/path node dist/bin.js report --task TASK_ID
```

`yy benchmark ...` is a transparent delegate to an independently installed compatible
`yylo-benchmark` executable. The standalone CLI remains canonical.

Legacy task-case plans also bind a USD 20 aggregate ceiling by default. `--max-usd` may
select another positive ceiling; planning divides it deterministically across the exact
model/attempt matrix. Live `run` requires a `juno_benchmark_task_authorization.v1` grant
whose plan, models, currency, expiry, aggregate ceiling, and per-attempt ceiling exactly
match the immutable plan. The grant is carried to both direct and authenticated YYLO
launchers, and its worst-case reservation is retained before provider dispatch.

## Project-owned workflow lifecycle

Workflow benchmarking uses the same generic command family; there is no consumer-specific
command. The project keeps one tracked Workflow Runner YAML as the prompt and deterministic
command source. A mandatory policy sidecar supplies stable scoring IDs, typed resources,
limits, redaction, recovery classification, a governed judge, and estimate metadata:

```bash
yylo-benchmark plan \
  --workflow .juno_task/workflows/example.yaml \
  --steps-file benchmark-policy.yaml \
  --steps collect,analyze,publish \
  --models :sol,:mini,zai/glm-5.2 \
  --var run_date=2026-08-12 --attempts 1 \
  --output workflow-plan.json --dry-run
yylo-benchmark run --plan workflow-plan.json --steps-file benchmark-policy.yaml --dry-run
yylo-benchmark recover --plan workflow-plan.json --steps-file benchmark-policy.yaml --dry-run
yylo-benchmark rejudge --plan workflow-plan.json --steps-file benchmark-policy.yaml --judge :sol --dry-run
```

Live execution uses one separately reviewed, hash-pinned JavaScript boundary module. The
package ships that reviewed module; `yylo-benchmark setup` installs its exact bytes into the
project and records the boundary digest, providers, and private registry binding without
copying or retaining credentials. `yylo-benchmark readiness` then proves exact
provider/model/YYLO identities with zero dispatch and retains the bounded receipt. The
module owns Workflow Runner/Juno credentials and external reconciliation. Candidate
operations receive only the immutable invocation. Judge operations receive only the blinded
request; they never receive candidate credentials or unblinded identity. Cost returned by the
runner is retained as best-effort evidence and never acts as dispatch authorization:

```bash
yylo-benchmark setup                       # installs .juno_task/boundary/yylo-workflow-boundary.mjs
yylo-benchmark readiness --models :mini,zai/glm-5.3
# Export the exact identities the setup receipt printed before planning a live run:
export YYLO_BENCHMARK_WORKFLOW_BOUNDARY=<installed-absolute-module-path>
export YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256=<lowercase-sha256-of-exact-module-bytes>
yylo-benchmark run --plan workflow-plan.json --steps-file benchmark-policy.yaml
yylo-benchmark recover --plan workflow-plan.json --steps-file benchmark-policy.yaml
yylo-benchmark rejudge --plan workflow-plan.json --steps-file benchmark-policy.yaml --judge :sol
```

`setup --synthetic` records synthetic transport intent for installed-CLI acceptance: the
reviewed module answers model dispatch and judge operations deterministically, spawns no
step children, and labels every synthetic terminal, so release tests and consumers without
credentials can exercise the complete lifecycle with zero provider dispatch. The packaged
`scripts/verify-installed-boundary-acceptance.mjs` runs that full gate against an installed
`yylo-benchmark` executable; `--normal-yy 1` additionally proves the identity surface against
the real PATH-resolved `yy` wrapper instead of the stand-in, and asserts that hash-consistent
but unparsable compiled bytes are rejected before any durable intent with a
`proven_not_dispatched` reconciliation. `scripts/verify-convert-installed-acceptance.mjs`
runs the tracked Convert Daily Ops workflow through setup -> readiness -> plan -> dry-run ->
synthetic first dispatch -> terminal -> recover with normal `yy` identity probing and zero
provider dispatch. Live preflight fails closed when a provider credential
(`OPENAI_CODEX_TOKEN`, `ZAI_API_KEY`), the exact model identity, or the exact YYLO version
is missing before any durable dispatch intent exists, and the boundary keeps a private
dispatch journal so recovery reconciles exact truth instead of guessing.

`yy benchmark` accepts the identical argument tail and preserves stdout, stderr, cwd, exit
status, and signals. Planning binds the tracked YAML's raw bytes, normalized semantics,
Git ref/commit/tree, stable selected IDs, variables, exact selector resolutions and alias
config bytes, Juno version, optional reviewed-boundary identity, policy bytes/semantics,
compiler version, per-model compiled bytes, and strict model/attempt/step order. Any valid
exact `provider/model` selector is accepted without `workflowModels` or a release-owned
catalog; aliases remain optional project config. The overlay compiler modifies only canonical `yy pi` argument
arrays. It never rewrites prompt text or deterministic commands, and rejects hidden,
ambiguous, or conflicting selectors. Workflow commands must be explicit argument arrays:
canonical `[yy, pi, ...]` arrays are model steps, while the deliberately minimal ordinary
surface is limited to direct `echo` and `printf` argv. A policy may additionally bind a
specific selected step to the exact tracked-script shape
`[env, PYTHONPATH=., python3, scripts/<path>.py, ...]`; Benchmark verifies the policy,
working directory, environment prefix, committed script bytes, and unchanged overlay argv
again before dispatch. No other environment assignment, interpreter mode, absolute/untracked
script, shell, wrapper, or inline code is accepted. Scalar commands and every other executable
are rejected instead of heuristically parsed.

Planning and every `--dry-run` are read-only and report `dispatch_count: 0`. Every canonical
`yy pi` command is classified as a model dispatch, but workflow plans contain no spend grant,
ceiling, or reservation. Complete and partial USD values are retained when supplied;
`unavailable` and `not_applicable` retain `usd: null` and remain valid evidence rather than
being converted to zero or harness failure. Policy estimates are optional exact
provider/model overrides; dry-runs report per-model `available`/`unavailable`, and omit a
total unless every selected model has an override. Reports expose complete cost, all observed cost,
and incomplete-cost counts. The CLI reads the boundary module through a non-symlinked
owner-matched file handle, verifies its exact digest and stable inode, and runs the pinned
bytes with the current Node executable. A protocol probe must advertise every provider before
preflight or dispatch. Before any durable intent, the boundary preflights every selected exact
provider/model and returns the same provider, model, and Juno version; substitution or partial
mixed-provider support fails before candidate dispatch. Rejudge writes a durable identity-bound intent before the governed
call, without financial authorization. The same module implements `preflight`,
`dispatch`, `reconcile`, `resume`, and blinded `judge`; malformed, timed-out, oversized,
identity-mismatched, or nonzero responses fail closed. Recovery reuses retained terminals or
asks the boundary to reconcile durable intent before a policy-permitted resume. Rejudge reads
the complete content-addressed receipt set, dispatches no candidate, and appends a new governed
judgement generation plus report.
The public runtime fully validates the compiled workflow bytes, resolves the exact
command, and checks the deterministic policy prefix before writing any durable dispatch
intent, so a rejected request stays provably not dispatched and recoverable without
deleting evidence. It takes persistent typed locks,
keeps production model experiments sequential, and makes ambiguous external effects
manual. Recovery reconciles retained intent/terminal evidence before any safe resume.
Rejudge uses retained blinded candidate truth and never accepts a candidate dispatcher.
The CLI intentionally fails actionably instead of inventing an unreviewed launcher or judge.

For historical suites, check out the exact source commit (a detached checkout is valid),
select stable IDs rather than positions, and keep the policy and expected raw/semantic
hashes beside the acceptance harness. `fixtures/convert-2026-08-12/expected.json` pins the
real Convert commit `816fa627...`, its 17-step workflow identity, the intended named
13-step selection, four exact models, injection points, resources, governed rubric,
estimates, and no execution grant. It contains no product prompts; acceptance must read
the pinned tracked YAML from the consumer Git object. `policy.yaml` describes requirements,
not financial authority. Any source, ref, policy, model, allowlist, or variable drift fails
closed before dispatch.

A case must carry the `benchmark-case` tag and valid `fields.benchmark` metadata. Its
task body is the candidate prompt. Planning is read-only and content-addressed. A
canonical run creates one related experiment task; `--no-record` additionally requires
`--non-canonical-scope fixture|local` and is only for non-canonical fixture work.

Set `YYLO_BENCHMARK_REGISTRY` to a private controller-resolved local registry before
commands that retain or read evidence. `YYLO_BENCHMARK_WORK_ROOT` may select retained
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
semantics. Pages under `.juno_task/wiki/yylo-benchmark/project/` are project-owned and
are never overwritten. V1 provides isolated Git objects in a fresh repository but truthfully treats the
same-user host filesystem as trusted; it does not claim container or hostile-host
isolation. Candidate execution receives a snapshot-local HOME/XDG and a sanitized
environment with credential and canonical-controller routing variables removed.

## Authenticated launcher boundary

Authenticated execution is available only through one reviewed launcher boundary. Set
all of `YYLO_BENCHMARK_AUTH_LAUNCHER`, `YYLO_BENCHMARK_AUTH_LAUNCHER_SHA256`, and
`YYLO_BENCHMARK_AUTH_PROVIDER`, plus exactly one of `YYLO_BENCHMARK_AUTH_ENV` or
`YYLO_BENCHMARK_AUTH_FILE`. Environment transports are provider-allowlisted:
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

`yylo-benchmark release-readiness --input measured-identities.json` emits the canonical
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
registry authority, invoke the repository's guarded YYLO release script described
in the root operator instructions and publish the reviewed benchmark tarball under the
next/RC tag. Any tree, version, tarball hash, CLI identity, review, authority, or clean
state mismatch restarts the gate. This project does not run that release or publication
as part of readiness validation.
