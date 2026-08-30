# YYLO Benchmark

YYLO Benchmark is the immutable planning, execution, recovery, and longitudinal-reporting layer for coding-agent evaluations. It is for evaluation engineers and operators who need reproducible task cases or project-owned workflow experiments with retained, integrity-bound evidence.

- npm package and CLI: [`@yylo/benchmark`](https://www.npmjs.com/package/%40yylo%2Fbenchmark) / `yylo-benchmark`
- Source: [yylo-dev/yylo-benchmark](https://github.com/yylo-dev/yylo-benchmark)

Benchmark invokes [YYLO](https://github.com/yylo-dev/yylo) for agent execution and uses [YYLO Ledger](https://github.com/yylo-dev/yylo-ledger) through its public task/receipt contract. It does not replace either package: YYLO owns agent and repository orchestration; Ledger owns Records and task history; Benchmark owns evaluation plans and its private evidence registry.

## Quick start: inspect without dispatch

**Prerequisites:** Node.js 20.10 or newer. The npm registry currently publishes `0.1.0-rc.1`; this package has no published stable release. Pin the prerelease explicitly:

```bash
npm install --global '@yylo/benchmark@0.1.0-rc.1'
yylo-benchmark --version
yylo-benchmark --help
yylo-benchmark init --stdout
```

A successful run prints `0.1.0-rc.1`, the public command inventory, and initialization configuration to stdout. `init --stdout` does not write project files or dispatch a model.

The source manifest in this checkout is `0.1.0-rc.7`. That source version is not present in verified npm registry metadata, so do not install or describe it as published. Check channels before changing a pin:

```bash
npm view '@yylo/benchmark' versions dist-tags --json
```

Next: choose a [task-case experiment](#task-case-experiments) or a [project-owned workflow experiment](#project-owned-workflow-experiments).

## Capabilities

| Need | Public commands | Evidence/safety boundary |
| --- | --- | --- |
| Initialize | `init` | Installs checksum-managed guidance/config; `--stdout` is read-only. |
| Task cases | `case`, `plan`, `run`, `regrade`, `doctor`, `report` | Live runs require a plan-bound authorization and configured private registry. |
| Workflow experiments | `setup`, `readiness`, `plan`, `run`, `recover`, `rejudge` | Dry-runs dispatch zero models; live work requires a reviewed boundary and exact identities. |
| Recovery | `recover`, `doctor` | Reconciles retained durable intent; it does not blindly redispatch ambiguous work. |
| Longitudinal analysis | `report`, `investigate` | Reads bounded retained evidence; it does not mutate candidate truth. |
| Release evidence | `release-readiness` | Offline artifact readiness only; no tag, publish, spend, or deployment authority. |

Use `yylo-benchmark COMMAND --help` as the exact option contract for the installed version.

## Project setup

Run initialization from the Git project that owns the cases or tracked Workflow Runner YAML:

```bash
yylo-benchmark init
```

This installs package-managed Benchmark guidance and configuration while preserving project-owned pages. Evidence-retaining commands require a private local registry selected by the operator:

```bash
export YYLO_BENCHMARK_REGISTRY=/private/operator-owned/benchmark-registry
```

The path is illustrative. Keep the registry outside candidate snapshots, private to the operator, and out of source control. `YYLO_BENCHMARK_WORK_ROOT` may select retained attempt workspaces.

## Task-case experiments

A task case is a YYLO Ledger task tagged `benchmark-case` with valid `fields.benchmark` metadata. Its task body is the candidate prompt.

```bash
yylo-benchmark case lint TASK_ID
yylo-benchmark plan --task TASK_ID --models :mini,:sol --attempts 3 --output plan.json
```

Replace `TASK_ID` with a real case ID. Planning is read-only and content-addressed. It binds the exact task, models, attempts, grader profile, source, and configured aliases. Legacy task-case plans use a USD 20 aggregate ceiling by default; `--max-usd` sets another positive plan ceiling.

A live run is intentionally a separate step:

```bash
yylo-benchmark run --plan plan.json --authorization /external/task-authorization.json
yylo-benchmark doctor EXPERIMENT_TASK_ID
yylo-benchmark report --task TASK_ID
```

The authorization and experiment IDs are placeholders. A live task run requires an exact `juno_benchmark_task_authorization.v1` grant matching the immutable plan's models, currency, expiry, aggregate ceiling, and per-attempt ceiling. A plan is not spend authority.

Use `--no-record` only with `--non-canonical-scope fixture|local`; it is not a canonical experiment.

## Project-owned workflow experiments

Workflow experiments benchmark stable step IDs from a tracked Workflow Runner YAML. A policy sidecar binds scoring IDs, resources, limits, redaction, recovery classes, governed judge behavior, and optional cost estimates.

### Safe planning canary

The following shape is read-only; replace the paths, step IDs, variables, and selectors with values that exist in your tracked project:

```bash
yylo-benchmark plan \
  --workflow .juno_task/workflows/example.yaml \
  --steps-file benchmark-policy.yaml \
  --steps collect,analyze \
  --models :sol,:mini \
  --var run_date=VALUE \
  --attempts 1 \
  --output workflow-plan.json \
  --dry-run

yylo-benchmark run --plan workflow-plan.json \
  --steps-file benchmark-policy.yaml \
  --dry-run
```

`VALUE` and the file/step names are explicit placeholders. Successful dry-runs report `dispatch_count: 0`; they never create spend authority.

Planning binds raw and normalized workflow/policy bytes, Git identity, selected stable IDs, variables, exact model resolution, compiler output, Juno version, and deterministic order. Workflow commands must use the accepted argv forms shown by package guidance; hidden shell wrappers, inline code, ambiguous selectors, and command rewriting are rejected.

## Reviewed execution boundary

Live workflow execution uses one package-shipped, hash-pinned JavaScript boundary module:

```bash
yylo-benchmark setup
yylo-benchmark readiness --models :mini,zai/glm-5.3
```

`setup` installs the reviewed boundary into `.juno_task/boundary/` and records its digest, providers, and private registry binding without copying credentials. `readiness` performs zero dispatch and retains exact provider/model/YYLO identity evidence.

Export the exact module path and SHA-256 printed by setup before planning or running live work:

```bash
export YYLO_BENCHMARK_WORKFLOW_BOUNDARY=/absolute/path/to/yylo-workflow-boundary.mjs
export YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256=LOWERCASE_SHA256
```

These values are placeholders and must match the setup receipt. The boundary owns provider credentials and external reconciliation. Candidate operations receive only the immutable invocation. Governed judges receive a blinded, versioned task/rubric/evidence packet and no candidate credential or model-identity route. Each valid verdict retains the exact observed judge provider/model/Juno/session envelope, runtime, cost completeness, exit status, strict verdict, and redacted factual justification.

### Credential-free synthetic acceptance

```bash
yylo-benchmark setup --synthetic
yylo-benchmark readiness --models :mini,zai/glm-5.3
```

Synthetic mode is for installed-CLI acceptance. It performs deterministic synthetic candidate/judge operations, labels all terminals, and does not dispatch a provider model. It is not evidence of live provider readiness.

## Run, recover, and rejudge

After separate review and authorization, live workflow commands are:

```bash
yylo-benchmark run --plan workflow-plan.json --steps-file benchmark-policy.yaml
yylo-benchmark recover --plan workflow-plan.json --steps-file benchmark-policy.yaml
yylo-benchmark rejudge --plan workflow-plan.json --steps-file benchmark-policy.yaml --judge :sol
# Legacy hash-only plans additionally require: --rubric-file retained-rubric.md
```

Safety invariants:

- Live preflight checks every exact provider/model and Juno identity before durable candidate intent.
- The boundary protocol and digest are revalidated before dispatch.
- Persistent typed locks keep production model experiments sequential.
- Known child terminals are retained, including harness failures; settled work is not redispatched.
- Recovery reconciles durable intent before policy-permitted resume. Ambiguous external effects remain manual.
- Rejudge reads retained blinded candidate truth, dispatches only missing or judge-invalid eligible work, and does not dispatch a candidate.
- Provider non-dispatch, timeout, nonzero exit, malformed/no-verdict output, missing identity/task/rubric/artifacts, and redaction failure leave quality unknown; they are never valid rejections.
- Reports separate candidate outcome, candidate-harness validity, judge validity, and quality. Unknown quality suppresses winner selection.
- Cost is evidence, not authorization. Missing cost stays unavailable; genuine zero stays zero.

Use dry-run first whenever it is offered:

```bash
yylo-benchmark recover --plan workflow-plan.json --steps-file benchmark-policy.yaml --dry-run
yylo-benchmark rejudge --plan workflow-plan.json --steps-file benchmark-policy.yaml --judge :sol --dry-run
```

## Evidence and doctor

Task experiments are identified by their Ledger experiment task ID. Workflow experiments use `workflow-` followed by a 64-character plan hash:

```bash
yylo-benchmark doctor EXPERIMENT_TASK_ID
yylo-benchmark doctor workflow-PLAN_ID_HEX
```

`doctor` verifies retained identities, receipts, terminal truth, and integrity links. Workflow doctor can operate entirely from retained private-registry evidence, including harness failures and ambiguous dispatch intents.

Benchmark execution consumes YYLO's public `juno_execution_envelope.v1`. Provider, model, session, version, and cost derive from marked backend evidence, not candidate prose. Grading is likewise bound to configured executable identity and integrity-linked grader artifacts; missing or tampered evidence fails closed.

## Offline release readiness

```bash
yylo-benchmark release-readiness --input measured-identities.json
```

The input is produced by the package's release verification contract, not hand-authored booleans. The resulting `juno_benchmark_release_readiness.v1` receipt binds a clean commit/tree, package identities, source/dist/tarball hashes, standalone and delegated CLI identities, and the exact bounded coverage and leak-scan evidence.

Release readiness is an offline D0 claim. It excludes live workflow/model execution, paid judging, tagging, npm publication, push, deployment, and production mutation. The source release workflow runs tests, typecheck, build, and exact tarball verification; prerelease versions use the `next` channel by contract. Separate owner and registry authority is still required for publication.

## `yy benchmark` delegation

When both packages are independently installed, YYLO exposes the same standalone CLI:

```bash
npm install --global '@yylo/cli@latest'
yy benchmark --help
yylo-benchmark --help
```

`yy benchmark` delegates the argument tail, cwd, standard streams, exit status, and signals. It does not discover a checkout-local Benchmark runtime. Install and version `@yylo/benchmark` independently.

## Development

```bash
git clone https://github.com/yylo-dev/yylo-benchmark.git
cd yylo-benchmark
npm ci
npm test
npm run typecheck
npm run build
node dist/bin.js --help
```

Package acceptance scripts include synthetic installed-boundary and tracked-workflow canaries. They intentionally prove zero provider dispatch; they do not grant live execution or publication authority.

## Help and links

- CLI: `yylo-benchmark --help`
- npm: [@yylo/benchmark](https://www.npmjs.com/package/%40yylo%2Fbenchmark)
- Source/issues: [yylo-dev/yylo-benchmark](https://github.com/yylo-dev/yylo-benchmark)
- YYLO CLI: [yylo-dev/yylo](https://github.com/yylo-dev/yylo)
- YYLO Ledger: [yylo-dev/yylo-ledger](https://github.com/yylo-dev/yylo-ledger)
