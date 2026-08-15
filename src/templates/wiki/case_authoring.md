---
wiki_contract:
  line_limit: 200
  purpose: "Define how to author reproducible, leak-resistant benchmark cases."
  failure_mode_prevented: "Prevents ambiguous prompts, future-solution leakage, and identity drift between attempts."
  runtime_contract_enforced: "Every case binds canonical work meaning, exact source, selected knowledge, grading, and policy inputs."
  validation_gate: "juno-benchmark case lint plus package tests"
  owns:
    - "Case eligibility and authoring guidance"
  does_not_own:
    - "Domain-specific project guidance"
    - "Hidden grader implementation"
---

# Case authoring

A benchmark case is a real engineering item selected through explicit owner opt-in.
Do not infer eligibility from labels, age, or convenience. The canonical body is the
candidate prompt unless a future version introduces another explicitly hash-bound field.

## Required qualities

A useful case has an exact source baseline, a clear resolved condition, representative
engineering scope, and checks that can distinguish correct behavior from plausible text.
Record its repository identity, full base commit, category, grader profile, and selected
project wiki paths. Increment the case version when intended meaning changes.

## Knowledge selection

Project guidance belongs under:

```text
.juno_task/wiki/juno-benchmark/project/
```

Select only pages relevant to the case. Paths must be normalized relative to
`.juno_task/wiki`, remain beneath `juno-benchmark/project/`, name regular Markdown
files, and contain no symbolic-link traversal. Each selected page passes the installed
Juno wiki linter. Exact SHA-256 values become case inputs, so edited knowledge creates
a different identity.

## Leakage review

Before accepting a case, verify that the exported candidate tree excludes reference
patches, future Git objects, hidden checks, unrelated controller metadata, credentials,
and package artifacts. Candidate-visible guidance may explain stable interfaces and
constraints, but must not reveal a future solution.

## Author checklist

- Confirm explicit opt-in and valid benchmark metadata.
- Pin a reachable full commit and repository identity.
- State one primary resolved outcome with deterministic evidence where possible.
- Declare candidate-visible and hidden checks deliberately.
- Select the minimum relevant project guidance and review its hashes.
- Declare tool, budget, safety, privacy, and production-access boundaries.
- Reject cases whose correctness cannot be judged or whose baseline cannot be rebuilt.
