# Roadmap (locked 2026-10-20)

Basis: offline analysis of the 2026-10-19 telemetry packs (141 deduplicated production runs: 120 Luna, 19 Astra, 2 Sol), plus the Astra discussions in `astra_telemetry_analysis.md` and `astra_feature_discussion.md`.

Goal of this phase: measure when delegation pays off (first-pass acceptance, real rewrite effort, failure cause) and fix the operational weak points the telemetry exposed. Distribution comes later.

Status (2026-10-20): steps 1–4 are implemented on branch `telemetry-fixes` and deployed on SERAPH. The step-5 routing rules are in `shared/ROUTING_POLICY.md` under "Evidence-based rules". Next: deploy on MSI (Windows + WSL), then collect runs.

Ground rules for the whole phase:
- Steps 1–4 run in order. Each step ships, deploys and passes its tests before the next starts.
- No extra model calls for telemetry. Everything is collected mechanically or during Opus's existing `assess`.
- Worker prompts stay frozen (prompt-freeze guard). If a step must change one, it updates the goldens on purpose and records the new prompt hash.
- Out of scope until step 5 is done: Claude Code plugin packaging, marketplace, full config waterfall (`extends`/`replace`/custom roles/directory level), SDK or app-server backends, adaptive routing.

## 1. Telemetry fixes (current wrapper, no new architecture)

Problems seen in the packs:
- 41 foreground runs have no `touched_files`. The wrapper only reads the companion's `touchedFiles` in `collect`, which only background runs go through.
- 9 runs never got a final status (6 `submitted_background`, 3 `running`), but most were assessed anyway. Background duration is submission time, not worker runtime.
- All 3 `failed` Luna runs were Opus packet errors (c2, f1, p6 attempt 1), and 3 git-guard violations came from Opus's own concurrent commits. The current fields can't tell these apart from model faults.
- Astra shows 204/210 findings accepted. Acceptance isn't verification.

Changes:
- **Touched files for every run:** after a foreground run, derive them from git: the files that changed during the run, plus files already dirty whose content hash changed.
- **Worker result snapshot:** when a run finishes (foreground end, or `collect`), record a git tree hash of the worker's result. Build it with a temporary index (`GIT_INDEX_FILE` + `git add -A` + `git write-tree`), so the user's index, refs and stash are untouched.
- **Rewrite measurement at `assess`:** diff the working tree against that snapshot, limited to the run's touched files. Store `post_worker_lines_added/removed` and `post_worker_files`. Flag `attribution: uncertain` when the tree was dirty or other runs touched the same files.
- **`assess` gains:**
  - `--cause` (several allowed): `model_error`, `spec_error`, `test_gap`, `runtime_gap`, `visual_fidelity`, `tool_error`, `quota`, `concurrency`.
  - `--verified`: `tests`, `runtime`, `visual` or `none`, meaning what Opus itself re-ran.
  - Astra only: `--verified-findings n` and `--critical-findings n`.
- **Lifecycle:** `submitted`, `running`, `completed`/`failed`/`cancelled`/`quota_exhausted`, `collected`, `assessed`. `assess` warns when a background run was never collected. Store `worker_duration_ms` separately from submission time.
- **Tests ran:** record whether the worker's report says the `required_checks` were executed. Detection is plain text matching on the report; no model call.
- **Offline analysis:** a `metrics --by project|role|cause|duration-bucket` view, plus a script that joins Claude Code session transcripts (token usage) to runs by working directory and time window, to estimate Opus overhead. Read-only and offline.
- Use the three existing packs as regression fixtures. The new code must read old records without errors.

Done when: every new run ends in a final state, has touched files, a worker tree hash and (once assessed) post-worker diff numbers. `metrics` can separate model-caused rework from spec-caused rework.

## 2. Worktree isolation

Evidence: rtmod already used manual worktrees (`rtmod-p2a`, `-p2b`, …). Concurrent runs caused false git-guard alarms and "partial status due to concurrent worker" notes.

- `run --worktree`: the wrapper creates `git worktree add <repo>-wt/<run-id> -b orch/<run-id>` from HEAD (or `--base <ref>`) and runs the worker there.
- The git guard watches the main repo's refs and the worktree's own ref, but allows the branch the wrapper itself created.
- `assess` reports the branch. Merging stays manual (Opus or the user); the wrapper never merges.
- `worktree-clean <run-id>` removes the worktree and its branch after merge or rejection, and refuses if the branch has unmerged commits unless `--force` is passed.
- A clean worktree also makes step 1's rewrite measurement precise.

Done when: two runs on the same repo run in parallel with no git-guard alarms, and each has its own touched files and rewrite numbers.

## 3. `codex exec` adapter

Evidence: in 125 of 144 runs, the companion was found inside a desktop-app session folder with UUIDs in its path. One quota-gate skip says it was "not discoverable from this session", and one result was lost because the companion reported "No job found".

- Wrap the current companion calls behind a small backend interface: `run`, `status`, `collect`, `cancel`.
- New default backend: `codex exec` with the model, sandbox, effort and prompt the role already sets. Use `--json` output if the installed CLI supports it.
  - Background mode: a detached process writes to a job folder under `~/.claude/orchestration/jobs/<run-id>/` (pid, stdout, stderr, exit code).
  - Touched files: from git (step 1), not from the companion.
- Keep the companion as `--backend companion` and as the fallback when the CLI is missing.
- Quota gate: deploy it with this step and record quota refusals as `quota_exhausted`, not as model failures.
- Parity check: the same validation packets (T001, R001) and golden prompts on both backends, with the same telemetry fields.

Done when: an Opus → Luna → Astra workflow runs with `codex-plugin-cc` uninstalled, using subscription login, the same sandbox and models, and the same telemetry.

## 4. Per-project packet defaults

Evidence: Midnight Tavern's main lesson ("unit tests pass but the game is broken") needed the same runtime-check requirement in every packet.

- Optional `<repo>/.orchestration/project.yaml`:
  - `constraints` and `required_checks` added to every Luna/Sol packet;
  - optional per-role `model` and `effort` overrides;
  - optional `context` text.
- Append only. It can't remove packet keys and can't touch sandbox, git rules or the Astra blind-review allowlist. Astra packets get no project text unless the project marks it `review_safe: true`.
- The run record stores the `project.yaml` hash and the final prompt hash, so runs stay comparable.
- `config --explain <role>` prints the effective model, effort, extra constraints and checks, and where each came from.

Done when: a project file adds a required check that shows up in the prompt and the run record, and tests prove it can't weaken the protected rules.

## 5. Collect, then re-analyse

- Routing-policy changes go in at the start of this step, so the new batch measures them:
  - split packets expected to take more than ~15 minutes (in the packs, 5–15 min runs had 51% accepted, 15–30 min runs 28%);
  - an Astra spec review before any phase with several packets;
  - discovering unknown behaviour stays with Opus; Luna implements behaviour that is already known;
  - game-engine packets need a runtime smoke test;
  - DSP or other algorithm-heavy work starts with a feasibility spike.
- Effort stays at `high` for this batch so it doesn't confound the other changes. A `medium` experiment comes later, on its own.
- **Prompt version 2 (2026-10-22).** Worker prompts were rebuilt from deduplicated fragments under `codex/prompts/`, and role prompts became overridable (`docs/superpowers/specs/2026-10-22-role-prompts-and-managed-blocks-design.md`). Golden sha256 prefixes:
  - luna-implement / sol-implement `5dc18a858bc5`
  - luna-test `7ba03d5a8096`
  - astra-review `01e6da372a67`
  - astra-investigate `54df5ccaeb8a`

  Analyse the runs before and after this change separately, using `prompt_sha256`, and exclude runs whose `role_prompt.source` isn't `default`. Deploy on every machine in the same sitting.
- Target: about 50 new production runs on both machines. Then repack, re-analyse with `metrics`, and decide on plugin packaging and the config waterfall from the evidence.
