# Orchestration telemetry proposal

This accompanies `codex-delegate-extended.mjs`.

## What stays unchanged

The extended wrapper preserves the current design:

- role-pinned models (`luna-implement`, `luna-test`, `sol-implement`, `astra-review`, `astra-investigate`)
- model-specific write/read-only sandbox selection
- packet contract validation
- blind Astra review field allowlist
- prompt construction from the existing `shared/` and `codex/` role documents
- delegation through OpenAI `codex-plugin-cc`'s `codex-companion.mjs`
- Git state guard
- existing `run`, `status`, `result`, `cancel`, `verify-git`, and `which` commands

No new npm dependency is introduced.

## Added telemetry

Every `run` writes a sidecar:

`~/.claude/orchestration/runs/<timestamp>-<task>-<role>.run.json`

Foreground runs also capture:

- `.stdout.txt`
- `.stderr.txt`
- existing `.prompt.md`
- existing `.git-baseline.json`

An append-only event stream is written to:

`~/.claude/orchestration/telemetry/events.jsonl`

Routing decisions that deliberately skip a normally applicable Codex delegation can be recorded in:

`~/.claude/orchestration/telemetry/routing-skips.jsonl`

## Recommended CLAUDE.md additions

Add a rule similar to:

```markdown
## Orchestration observability

For every substantive task, explicitly make a routing decision using the project routing policy.

When delegating through `codex-delegate.mjs`:
- always pass `--reason` with a concise routing justification;
- pass `--task-type` using a stable category such as implementation, test, design_review, investigation, creative_pipeline, or refactor;
- pass `--parent` when the run belongs to a larger feature/task;
- use `--budget-key` and `--max-attempts` for workflows that could otherwise ping-pong between agents.

When a task matches a normal delegation rule but delegation is intentionally skipped, call `record-skip` with the reason.

After reviewing a completed delegated run, record its outcome using `assess`.
Do not mark a run useful merely because it completed successfully.

For Luna implementation/test runs:
- `accepted`: acceptance criteria met without substantive correction.
- `minor_rework`: small corrections were required.
- `major_rework`: substantial Opus repair or another worker pass was required.
- `failed`: delegation did not provide a usable implementation/result.

For Astra reviews:
- set `--findings` to the number of actionable findings;
- set `--accepted-findings` to findings Opus actually accepts as valid/useful;
- set `--useful yes` only if the review materially improved the plan, design, implementation, risk analysis, or validation;
- a review that only says the artifact is fine should normally be `--useful no` unless independent confirmation was specifically valuable for a high-risk decision.

During the evaluation period, finish substantive responses with a compact line such as:
`Orchestration: Opus → Luna implementation → Opus review`
or
`Orchestration: Opus only — delegation not warranted.`
```

## Example calls

### Luna implementation

```powershell
node ~/.claude/orchestration/scripts/codex-delegate.mjs run `
  --role luna-implement `
  --packet .orchestration/tasks/combat-knockback.yaml `
  --cwd . `
  --reason "bounded implementation from approved combat spec" `
  --task-type implementation `
  --parent combat-knockback `
  --budget-key combat-knockback:implementation `
  --max-attempts 2
```

### Astra independent design review

```powershell
node ~/.claude/orchestration/scripts/codex-delegate.mjs run `
  --role astra-review `
  --packet .orchestration/tasks/inventory-review.yaml `
  --cwd . `
  --reason "independent review of a cross-system feature design" `
  --task-type design_review `
  --parent inventory-v2 `
  --budget-key inventory-v2:astra-review `
  --max-attempts 1
```

### Assess a Luna run

```powershell
node ~/.claude/orchestration/scripts/codex-delegate.mjs assess <run-id> `
  --outcome accepted `
  --useful yes `
  --rework-rounds 0 `
  --notes "all acceptance criteria passed; no Opus patch required"
```

### Assess an Astra review

```powershell
node ~/.claude/orchestration/scripts/codex-delegate.mjs assess <run-id> `
  --outcome accepted `
  --useful yes `
  --findings 4 `
  --accepted-findings 2 `
  --notes "two findings changed persistence boundaries and test strategy"
```

### Record a deliberate skip

```powershell
node ~/.claude/orchestration/scripts/codex-delegate.mjs record-skip `
  --task-id rename-save-label `
  --task-type implementation `
  --role luna-implement `
  --reason "single literal change; delegation overhead exceeds expected work"
```

### Inspect usage

```powershell
node ~/.claude/orchestration/scripts/codex-delegate.mjs runs --limit 20
node ~/.claude/orchestration/scripts/codex-delegate.mjs metrics
node ~/.claude/orchestration/scripts/codex-delegate.mjs metrics --role astra-review --since 30
```

## Metrics currently calculated

The `metrics` command derives:

- total runs
- assessment coverage
- first-pass acceptance rate
- material rework rate
- usefulness rate
- Astra review no-op rate
- Astra finding acceptance rate
- total and average runtime
- per-role run count, acceptance rate, usefulness rate, and average runtime

These are intentionally simple. They should be enough to decide whether a route is useful before adding more sophisticated accounting.

## Important limitation: token accounting

This wrapper cannot reliably infer actual subscription-token or quota consumption unless the installed OpenAI companion exposes stable machine-readable usage metadata. It therefore measures *calls, duration, rework, findings and utility* rather than inventing token counts.

If a future `codex-companion` result exposes token/usage fields, add those fields to each `.run.json` rather than scraping human-readable terminal output.

## Background jobs

Foreground runs are fully captured.

For background runs, the wrapper records submission metadata, but the OpenAI companion remains the owner of the asynchronous job. The current extension deliberately does not scrape or reverse-engineer the plugin's internal job store.

A later iteration could add a tracked `collect <run-id> <job-id>` command once the exact stable output schema of `codex-companion result` is confirmed on the installed plugin version.

## Suggested evaluation period

Use the telemetry for roughly 30–50 substantive tasks before aggressively changing routing policy.

Questions to answer:

- What percentage of Luna implementation tasks are accepted first pass?
- How often does Opus materially repair Luna's output?
- Which task types cause Luna → Sol/Astra escalation?
- What percentage of Astra reviews produce zero actionable findings?
- What percentage of Astra findings are accepted by Opus?
- Which kinds of design tasks show the highest review utility?
- Does the extra wall-clock time correlate with fewer regressions/rework?

Then narrow or expand routing based on actual project results rather than model reputation.
