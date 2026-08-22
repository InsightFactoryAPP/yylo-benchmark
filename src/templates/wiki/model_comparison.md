---
wiki_contract:
  line_limit: 200
  purpose: "Define reliability-first comparison and cheapest-good-enough recommendation evidence."
  failure_mode_prevented: "Prevents universal scoring, invalid-run bias, and unsupported model-routing claims."
  runtime_contract_enforced: "Comparisons preserve repeated resolved outcomes, uncertainty, economics, runtime, and system identity."
  validation_gate: "yylo-benchmark comparison and longitudinal report tests"
  owns:
    - "Model and agent-system comparison guidance"
  does_not_own:
    - "Automatic routing or deployment decisions"
---

# Model comparison

The primary measure is whether one isolated attempt resolves the engineering case.
Compare repeated valid attempts to estimate reliability. Keep cost, elapsed runtime,
invalid-run rate, and repeat consistency as separate dimensions rather than collapsing
them into a universal score.

## Comparable evidence

Only combine attempts when their case meaning and compatibility inputs permit it.
Preserve exact prompt, source, selected wiki, tool policy, budget, package, grader, and
agent-system identities. Separate model-only comparisons, where the surrounding system
is fixed, from whole-agent-system comparisons.

Infrastructure-invalid attempts remain visible in invalid-run statistics but do not
become model failures. Report missing or partial economics explicitly. Include sample
size and uncertainty; small repeated samples support cautious recommendations, not
claims of universal superiority.

## Cheapest good enough

Define the reliability threshold and category before inspecting the winner. Among
systems meeting that threshold, recommend the least expensive supported option and an
escalation option where evidence warrants one. Report cost per successful resolution
alongside raw cost and reliability so cheap unresolved work is not rewarded.

## Longitudinal use

New-model experiments append evidence without rerunning compatible historical attempts.
Reports identify included and excluded evidence and explain compatibility decisions.
Regression suites track whether a recommendation remains dependable over time.
Recommendations are advisory: they do not mutate production routing or deploy candidate
patches.

## Report checklist

- Resolved counts and reliability with sample size and uncertainty.
- Invalid-run rate and typed failure breakdown.
- Complete, partial, and unavailable cost coverage.
- Runtime distribution and repeat consistency.
- Category and model-only versus system-level scope.
- Cheapest-good-enough and escalation rationale.
- Exact evidence and derivation hashes.
