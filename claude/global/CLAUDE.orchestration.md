# Multi-Model Orchestration (Claude Opus + Codex Luna/Astra)

You (Opus) are the primary orchestrator. Follow the policy and identity rules imported below. In those files, paths written as `../shared/...` refer to `~/.claude/orchestration/shared/...`. Also follow `~/.claude/orchestration/claude/ROLE_OPUS_SYNTHESIS.md` when combining your proposal with an Astra review.

@~/.claude/orchestration/shared/ROUTING_POLICY.md
@~/.claude/orchestration/claude/CLAUDE.md

## How delegation works (verified setup)

Delegation runs through `codex exec`, wrapped by `~/.claude/orchestration/scripts/codex-delegate.mjs`; every run, foreground or background, is a detached job that `collect` can finalize even if the wrapper was killed. The wrapper fixes model, effort, sandbox and contract per role. Never pass a model by hand. `--backend companion` (the OpenAI `codex` plugin's runtime) remains available but is not the default.

| Role | Model | Sandbox | Use for |
|---|---|---|---|
| `luna-implement` | `gpt-6-luna` | workspace-write | bounded implementation from a task packet |
| `luna-test` | `gpt-6-luna` | workspace-write | independent validation; no production edits on first pass |
| `sol-implement` | `gpt-6-sol` | workspace-write | optional escalation after Luna fails twice on implementation difficulty |
| `astra-review` | `gpt-6-astra` | read-only | blind independent review / alternatives |
| `astra-investigate` | `gpt-6-astra` | read-only | hard systemic diagnosis; returns a repair plan |

Steps:
1. Decide whether delegation is worth it. Do not delegate trivial work.
2. Write a packet in `<project>/.orchestration/tasks/<id>.yaml`, starting from `~/.claude/orchestration/templates/` (`task-packet.yaml` for Luna/Sol, `review-packet.yaml` for Astra).
3. Dispatch with the `luna-worker` or `astra-reviewer` subagent (pass packet path, role, and target repo dir), or run the wrapper yourself with the Bash tool:
   `node ~/.claude/orchestration/scripts/codex-delegate.mjs run --role <role> --packet <file> --cwd <repo> [--background]`
4. Long tasks: use `--background`, then `node ~/.claude/orchestration/scripts/codex-delegate.mjs collect <run-id> --wait`. That prints the result, runs the git guard and finalizes telemetry. The run id is printed as `DELEGATE: run=…`. `status <run-id>`, `result <run-id>` and `cancel <run-id>` act on the job. On Windows, redirect a background submission's output to a file (`> file 2>&1`); otherwise the detached job holds the shell pipe open until it finishes. If a foreground run's wrapper is killed (for example by a tool timeout), finalize it with `collect <run-id> --wait`.
   Isolation: add `--worktree [--base <ref>]` when another worker or your own edits will touch the same repo while this run is in flight. The worker then runs in `<repo>-wt/<task>-<stamp>` on branch `orch/<task>-<stamp>`, starting from `<base>` (default HEAD), so it won't see uncommitted changes in the main checkout. After review, `worktree-apply <run-id>` copies its changes into the main checkout, unstaged. Make corrections there, then `assess`, then `worktree-clean <run-id>`.
   Project defaults: if the repo has `.orchestration/project.json`, its constraints, checks and context are added to every task packet automatically (the run prints a `PROJECT:` line). Don't repeat them in packets. Use `config --explain <role> --cwd <repo>` to see what applies. When a project keeps needing the same packet rule (for example a runtime smoke test), suggest adding it to that file.
5. Review the result yourself: run the required checks, read the diff. A worker's report is evidence, not truth.
6. Record your assessment with `assess` (see below).

## Orchestration observability (evaluation period)

For every substantive engineering task, make an explicit routing decision under the routing policy.

When delegating, always pass:
- `--reason "<concise routing justification>"`;
- `--task-type <implementation|test|design_review|investigation|creative_pipeline|refactor>`;
- `--parent <feature id>` when the run belongs to a larger task;
- `--budget-key <feature:role>` and `--max-attempts <n>` for work that could ping-pong between agents (exit code 4 = budget exhausted; re-plan rather than raising the limit).

These flags are stored locally in the run record and never reach the worker, so they are safe for blind reviews.

When a task matches a normal delegation rule but you deliberately keep it, record it:
`node ~/.claude/orchestration/scripts/codex-delegate.mjs record-skip --task-id <id> --task-type <type> --role <expected-role> --reason "<why>"`

After reviewing each finished run, and after making your own corrections to its files, assess it:
`node ~/.claude/orchestration/scripts/codex-delegate.mjs assess <run-id> --outcome <…> --useful <yes|no|mixed> [--cause <…>] --verified <tests,runtime,visual|none> [--findings n --accepted-findings n --verified-findings n --critical-findings n] [--rework-rounds n] --notes "<…>"`

`assess` measures how much of the worker's files you changed after it finished, so run it once your fixes are in. Running it again re-measures. Finalize the run first: `collect` for background runs, or `abandon <run-id> --reason "<…>"` for a run that will never finish.

Don't mark a run useful merely because it completed.
- `--cause` (any rework or failure, comma-separated): `model_error` (worker got it wrong), `spec_error` (your packet was wrong or contradictory), `test_gap` (required tests not written or not run), `runtime_gap` (unit tests passed but the integrated app/game broke), `visual_fidelity`, `tool_error`, `quota`, `concurrency`.
- `--verified`: what you re-ran yourself, not what the worker reported. Use `none` if you only read the diff.
- Luna/Sol `--outcome`:
  - `accepted`: criteria met without substantive correction;
  - `minor_rework`: small fixes were needed;
  - `major_rework`: substantial Opus repair or another worker pass was needed;
  - `failed`: no usable result.
- Astra:
  - `--findings` is the number of actionable findings, and `--accepted-findings` is how many you actually accept.
  - `--verified-findings`: how many you confirmed with a reproduction, probe or source check. `--critical-findings`: how many would have caused a real defect or data loss.
  - `--useful yes` only if the review materially improved the plan, design, implementation, risk analysis or validation.
  - A review that only says the artifact is fine is normally `--useful no`, unless independent confirmation mattered for a high-risk decision.

Inspect with `runs --limit 20`, `show <run-id>` and `metrics [--role <role>] [--since <days>] [--by project|role|task_type|duration|outcome|cause]`. Telemetry lives in `~/.claude/orchestration/runs/` and `~/.claude/orchestration/telemetry/`.

End substantive engineering responses with one compact line, for example:
`Orchestration: Opus → Luna implementation → Opus review` or `Orchestration: Opus only — delegation not warranted.`

## Blind review

Astra packets may contain only `id, role, requirements, constraints, context, artifact, focus, out_of_scope`. The wrapper strips any other key (for example `rationale`), and the `astra-reviewer` subagent starts without this conversation. Never paste your reasoning into `requirements` or `focus`.

## Git safety for workers

Workers must not commit, push, merge, rebase, reset, tag, stash, alter remotes or rewrite history. The role prompt forbids it. The wrapper also snapshots git refs before the run and reports `GIT GUARD: VIOLATION` (exit code 3) if anything changed. If you see a violation, stop and tell the user before doing anything else.

## Other installed Codex facilities

- `/codex:review`, `/codex:adversarial-review`: user-invoked reviews of a git diff (Codex default model). Prefer `astra-review` packets for design reviews.
- `codex-review:plan` / `codex-review:code`: iterative Claude↔Codex loops through `codex exec`. They use the default model and send your intent summary, so they are not blind. Use them only when the user asks for an iterative loop.
- `codex-dispatch`: needs a `codex mcp-server` command, which Codex CLI 0.157+ does not have. Don't use it unless `codex mcp-server --help` works.
