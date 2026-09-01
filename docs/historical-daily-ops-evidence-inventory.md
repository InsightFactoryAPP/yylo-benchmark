# Historical Daily Ops evidence inventory

Status: v2 migration input; read-only provenance inventory. This document does
not declare a canonical historical score.

## Generations

| Generation | Recoverable identity | Published aggregate | Candidate/session evidence | Judge provenance | Disposition |
|---|---|---:|---|---|---|
| Narrative Daily Ops run | Archived task `imhy2u` body in the controller Ledger | Mini 32/39, Sol 33/39, Luna 20/39 | Aggregate cost and outcome claims only; underlying per-attempt receipts are unavailable in this worktree/controller snapshot | Anonymous frontier judge is described, but exact model, prompt, rubric, order, generation, and receipt identities are unavailable | Unresolved; never an automated v2 oracle |
| PDR narrative variant | `P0-yylo-benchmark-v2-flexible-evaluation-pdr.md` | Mini 35/39, Sol 33/39, Luna 29/39, GLM 17/39 | Referenced candidate sessions/artifacts and `vibe-check` specifications are absent | Exact judge inputs and aggregate derivation are absent | Conflicts with archived blueprint; unresolved |
| Archived canonical blueprint | Historical source quoted by the v2 PDR and archived task `imhy2u` | Mini 32/39, Sol 33/39, Luna 20/39; GLM omitted | No immutable per-attempt artifact IDs are available here | No hash-bound generation can be reconstructed | Unresolved |
| Installed Mini/GLM governed run | Controller Ledger task `D0tTNr`, response last modified 2026-08-29 | Mini 0/13 judge passes; GLM 0/13 judge passes; each has 11 valid candidate successes and 2 retained harness-invalid outcomes | Plan `sha256:151f624290903674a907bc89af85edad3ff5ea2fd615a7091b149d0d386832e7`; readiness `sha256:65670397c7ea6c01fcca31f2b3e2a30a735f0aa35ae85a6c853de411a3bb7650`; manifest head `sha256:2b7ffe3db9ff8783918c97253b9f48c8ce8b051897f8ce2b763f5ec2c9dab171`; 22 outer session IDs are asserted but their values and registry objects are not present here | Governed blinded judge `openai-codex/gpt-5.6-sol`; all 26 stated verdicts are fail; exact prompt/rubric bytes and judge receipt IDs are unavailable here | Distinct generation; must not be combined with 39-case totals |

## Reconciliation result

The 35/32 Mini and 29/20 Luna discrepancies cannot be derived from the retained
inputs available to this implementation worktree. GLM appears only in a
narrative total and the later, separate 13-case generation. No score is promoted
or repaired. V2 reports must cite immutable attempt-evidence and evaluation IDs
for every aggregate; unavailable historical inputs remain unavailable.

The inventory was derived from immutable controller task reads and the canonical
v2 PDR. It intentionally does not copy or modify controller Ledger records,
private registries, sessions, or historical package artifacts.
