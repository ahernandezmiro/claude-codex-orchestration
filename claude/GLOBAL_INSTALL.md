# Claude-side global install: what was done, and how to reproduce it

This file adds to `BOOTSTRAP.md`; it doesn't replace it. `BOOTSTRAP.md` says *what* the setup must achieve. This file records *how* it was achieved on the first machine (2026-10-02, Windows 11, Claude desktop app, Codex CLI 0.157.1), so the same kit can be dropped onto another machine and Claude can repeat it.

**To Claude on a new machine:** read this file top to bottom, run section 2, adapt using section 5 if any preflight check fails, run the validation in section 6, and report results and manual actions as in section 7. The user has approved global installation into `~/.claude`. Still back up before changing anything (the installer does this), and never touch `~/.codex/*` without asking.

---

## 1. Architecture

```
you ──► Claude Code (Opus, orchestrator)
          │  reads ~/.claude/CLAUDE.md  (3-line managed block → @imports CLAUDE.orchestration.md → routing policy + identity)
          │  writes task / review packets  (<project>/.orchestration/tasks/*.yaml)
          ▼
        subagent luna-worker / astra-reviewer   (~/.claude/agents, haiku, Bash only, no conversation context)
          ▼
        node ~/.claude/orchestration/scripts/codex-delegate.mjs run --role <role> --packet <file> --cwd <repo>
          │  • quota gate: Codex 5h window minus ongoing reservations vs config/quota.json → BLOCKED (exit 5)
          │  • role fixes model + sandbox + contract (caller can't choose the model)
          │  • astra-review: drops every packet key outside an allowlist (blind review)
          │  • builds a self-contained prompt: safety rules + role doc + contract + packet
          │  • snapshots git refs before, compares after → GIT GUARD OK / VIOLATION (exit 3)
          │  • telemetry: <run>.run.json + events.jsonl; per-bucket attempt budget (exit 4)
          ▼
        codex-companion.mjs task …   (OpenAI "codex" Claude plugin = codex-plugin-cc; found automatically)
          ▼
        Codex app-server → gpt-6-luna / gpt-6-astra / gpt-6-sol under the ChatGPT subscription
```

| Role | Model | Codex sandbox | Contract returned |
|---|---|---|---|
| `luna-implement` | `gpt-6-luna` | workspace-write | `codex/prompts/contracts/task.md` |
| `luna-test` | `gpt-6-luna` | workspace-write | `codex/prompts/contracts/task.md` |
| `sol-implement` | `gpt-6-sol` | workspace-write | `codex/prompts/contracts/task.md` |
| `astra-review` | `gpt-6-astra` | read-only | `codex/prompts/contracts/review.md` (verdict/findings/alternatives) |
| `astra-investigate` | `gpt-6-astra` | read-only | `codex/prompts/contracts/result.md` |

All roles use reasoning effort `high` (the companion accepts at most `xhigh`; override per run with `--effort`).

The table shows the original values. Since the kit moved to the `orchestration-kit` repo, the model and default effort per role come from `claude/global/config/models.json` (installed to `~/.claude/orchestration/config/`), with an optional per-machine `models.local.json`. Run `node ~/.claude/orchestration/scripts/codex-delegate.mjs models` to see the effective selection. Every run record stores the `model` and `effort` actually used.

---

## 2. Quick path

Use the deploy script at the repo root. It checks Node, runs the prompt-freeze guard, then calls `install.mjs`. Fresh installs and updates are the same command.

```powershell
.\deploy.ps1 -Check
```
```powershell
.\deploy.ps1
```
On Linux/WSL: `./deploy.sh --check`, then `./deploy.sh`.

Then **start a new Claude Code session**. Agents and `CLAUDE.md` only load at session start. Run the validation in section 6.

Other modes (`deploy.ps1` switch / `deploy.sh` flag):
- `-DryRun` / `--dry-run` shows what would change.
- `-Uninstall` / `--uninstall` removes everything the installer added (with backups), but keeps `~/.claude/orchestration/runs/` and `telemetry/`.
- `-Uninstall -Purge` / `--uninstall --purge` also deletes that data.
- `-AllowPromptChange` / `--allow-prompt-change` skips the prompt-freeze guard (only after the evaluation is closed).

Each deploy deletes and re-copies the kit-managed folders under `~/.claude/orchestration` (`shared, codex, claude, scripts, templates, config`), so files removed from the kit disappear too. It also writes `deployed.json` with the commit and effective models.

---

## 3. Step-by-step log of what was done (first machine)

### Step 1: Discover what is installed (BOOTSTRAP actions 1–2)

1. Read all of `shared/`, `claude/` and `codex/`.
2. Looked for the three Codex plugins. They are **not** in `~/.claude/plugins/installed_plugins.json`. The Claude desktop app manages them remotely under
   `%APPDATA%\Claude\local-agent-mode-sessions\<org>\<account>\rpm\plugin_<id>\` (identify each by `.claude-plugin/plugin.json` → `name`).
   With the Claude Code CLI they would be under `~/.claude/plugins/cache/<marketplace>/<name>/<version>/`.
3. Commands and agents found:
   - **OpenAI `codex` (codex-plugin-cc) v1.0.6**: agent `codex:codex-rescue`; commands `/codex:rescue`, `/codex:review`, `/codex:adversarial-review`, `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:setup`, `/codex:transfer`; runtime `scripts/codex-companion.mjs`. The useful runtime command is
     `task [--background] [--write] [--resume-last|--fresh] [--model M] [--effort E] [--prompt-file F] [--cwd D]`. Without `--write` it runs read-only, and with `--write` it runs workspace-write. Background jobs are tracked per repo and visible through `status` and `result`.
   - **Codex Dispatch (`codex-dispatch`)**: a single skill that requires a **Codex MCP server**. `codex mcp-server` does not exist in Codex CLI 0.157.1 (it is treated as a prompt), so **this plugin cannot work** with that build. It was left installed but unused.
   - **`codex-review`**: skills `codex-review:plan` and `codex-review:code`. These run iterative `codex exec -s read-only` loops with Codex's default model and include Claude's intent summary, so they are **not blind**. They were kept as an optional user-invoked tool.
4. Codex checks: `codex --version` gave 0.157.1, and `codex login status` reported a ChatGPT login.
5. Model IDs: read `~/.codex/models_cache.json` (`models[].slug`) and found `gpt-6-luna`, `gpt-6-astra`, `gpt-6-sol` (also `gpt-6.1-sol`, `gpt-5.6-*`). Display names (`GPT-6-Luna`) differ from the IDs.
6. `node <companion> setup --json` reported `ready: true`.

### Step 2: Choose the transport

The OpenAI plugin's companion runtime was chosen over `codex exec` and over the MCP route because it is the installed integration, it supports per-run model, effort and sandbox selection, and it supports background jobs with `status` and `result`.

The plugin's own `codex:codex-rescue` agent was not reused for the roles, for three reasons: by design it leaves the model unset (which falls back to Codex's default), it defaults to write access, and it rewrites prompts. A small wrapper, `codex-delegate.mjs`, was written instead to pin the role to a model and sandbox. It locates the companion at run time, so it survives plugin updates and differs harmlessly between machines.

### Step 3: Write the wrapper and agents (BOOTSTRAP actions 3, 7, 8, 9)

Source files in the kit (`claude/global/`), with where the installer copies them:

| Kit source | Installed to | Purpose |
|---|---|---|
| `scripts/codex-delegate.mjs` | `~/.claude/orchestration/scripts/` | role-pinned delegation, blind-review key filter, git guard, telemetry; commands `run/status/result/cancel/collect/abandon/worktree-apply/worktree-clean/verify-git/which/runs/show/assess/record-skip/metrics`; uses `telemetry-lib.mjs` for tree snapshots and attribution |
| `agents/luna-worker.md` | `~/.claude/agents/` | forwards a task packet to `luna-implement` / `luna-test` / `sol-implement` |
| `agents/astra-reviewer.md` | `~/.claude/agents/` | forwards a review packet to `astra-review` / `astra-investigate` |
| `templates/task-packet.yaml`, `review-packet.yaml` | `~/.claude/orchestration/templates/` | packet starting points |
| `CLAUDE.orchestration.md` | `~/.claude/orchestration/claude/`, imported by the `orchestration-kit:claude-md` block in `~/.claude/CLAUDE.md` | routing rules, role table, workflow, blind-review and git rules |
| `scripts/managed-block.mjs` | `~/.claude/orchestration/scripts/` | id-scoped marker blocks; refuses unmatched, duplicate or nested markers |
| `settings.permissions.json` | merged into `~/.claude/settings.json` | allow the wrapper; *ask* before `git push/merge/rebase/reset --hard/remote/filter-*` and `commit --amend` |
| `../../shared`, `../../codex`, `../*.md` | `~/.claude/orchestration/{shared,codex,claude}/` | `codex/prompts/` is what the wrapper assembles into worker prompts; the rest is policy that CLAUDE.md imports |

Design decisions:
- **Blindness is enforced by structure, not convention.** The subagents start with no conversation context, and the wrapper sends only allowlisted packet keys (`id, role, requirements, constraints, context, artifact, focus, out_of_scope`) for `astra-review`, printing `BLIND REVIEW: stripped …` for anything else.
- **Git safety has two layers.** The prompt forbids every git mutation, and a before/after snapshot of HEAD, branch, all refs, remotes and stash produces a hard `GIT GUARD: VIOLATION` (exit 3). For background runs, the baseline is saved and checked later by `collect` (or by `verify-git`).
- **Prompts are self-contained.** Base rules, role prompt and contract are inlined, so the target repo needs no kit files. Only the role prompt can be overridden (README "Role prompt overrides"). Prompts and baselines are kept under `~/.claude/orchestration/runs/` for auditing.

### Step 4: Install globally

This was first done project-local, then moved to global at the user's request. `install.mjs` copies the files above, inserts a marker-delimited block into `~/.claude/CLAUDE.md` (it created the file, since none existed), and merges the permission arrays into `~/.claude/settings.json` with de-duplication. Existing keys such as `enabledPlugins` and the pre-existing agents `code-architect.md` and `plan.md` were left untouched.

### Step 5: Validate (MANUAL_SETUP §6)

All four tests passed. See section 6 for the commands.

### Step 6: Telemetry extension (2026-10-03)

The user supplied `orchestration_telemetry_extension.zip`, which contained `codex-delegate-extended.mjs` and `ORCHESTRATION_TELEMETRY_PROPOSAL.md`. The proposal is now kept in the kit as `claude/ORCHESTRATION_TELEMETRY_PROPOSAL.md`. After review, it was applied with four fixes.

What the extension adds:
- a `<run>.run.json` record per run, plus captured `stdout`/`stderr`;
- `telemetry/events.jsonl` and `telemetry/routing-skips.jsonl`;
- run flags `--reason`, `--task-type`, `--parent`, `--attempt`, `--budget-key` and `--max-attempts` (an attempt limit per budget bucket; exit 4 when exceeded);
- commands `runs`, `show`, `assess`, `record-skip` and `metrics`.

These flags are stored locally and are never put in the worker prompt, so blind review is unaffected.

Fixes applied on top of the supplied script:
1. `git()` used `trim()`, which removed the meaningful leading space of the first `git status --porcelain` line. That recorded ` M src/x.js` as `rc/x.js`. Changed to `trimEnd()`.
2. Background runs were never finalized: no job ID, a status stuck at `submitted_background`, the ~1-second submission time recorded as duration, and no git-guard result. Now:
   - the submission output is captured and the companion job ID stored;
   - a new `collect <run-id> [--wait]` reads `codex-companion result <job> --json`. Its fields `storedJob.status`, `startedAt`, `completedAt`, `result.status`, `result.rawOutput` and `result.touchedFiles` were verified on plugin v1.0.6;
   - `collect` saves the output, runs the git guard, and records the real job duration and final status.
3. `changed_files_after` includes files that were dirty before the run, so `dirty_before` is now recorded too.
4. `install.mjs --uninstall` would have deleted the evaluation data. It now keeps `runs/` and `telemetry/` unless `--purge` is given.

Also updated:
- the agents pass the telemetry flags through and report exit 4;
- the managed `CLAUDE.md` block gained an "Orchestration observability" section: always pass `--reason`/`--task-type`, `assess` every reviewed run, `record-skip` deliberate non-delegation, and end substantive responses with an `Orchestration:` line. It also uses `collect` for background runs.

Confirmed limitation: the companion's result JSON has **no token or usage fields**. Telemetry therefore measures calls, duration, rework and findings, not quota.

Validation runs on the first machine were moved to `runs/_validation/` and `telemetry/_validation/`, so they don't skew the evaluation period. `metrics` only reads the top level.

---

## 4. Files in this kit added by the setup

```
claude/GLOBAL_INSTALL.md                 ← this file
claude/ORCHESTRATION_TELEMETRY_PROPOSAL.md  ← telemetry design notes (step 6)
claude/global/install.mjs                ← installer (--check | --dry-run | --uninstall [--purge])
claude/global/CLAUDE.orchestration.md
claude/global/settings.permissions.json
claude/global/scripts/codex-delegate.mjs
claude/global/scripts/quota-gate.mjs     ← Codex quota read + gate (used by `run` and `quota`)
claude/global/config/models.json         ← model + default effort per role (models.local.json: per-machine, gitignored)
claude/global/config/quota.json          ← quota-gate threshold/reservation per role
claude/global/agents/{luna-worker,astra-reviewer}.md
claude/global/templates/{task-packet,review-packet}.yaml
claude/global/test/create-playground.mjs
claude/global/test/{T001-slugify,T002-forbidden-git,R001-slug-registry,I001-investigate}.yaml
claude/global/test/prompt-freeze.mjs     ← prompt-freeze guard; golden/ holds the baseline prompts
claude/global/test/quota-gate.test.mjs   ← quota gate tests (`node --test`, no Codex calls)
deploy.ps1, deploy.sh                    ← repo root: deploy (install/update) on Windows / Linux-WSL
playground/                              ← disposable test repo from the first machine; don't copy it
```

Edit files in the repo (the source of truth), commit, then run the deploy script on each machine. Don't edit the installed copies; the next deploy overwrites them.

---

## 5. Adapting on a new machine

| Preflight failure | Fix |
|---|---|
| `codex CLI on PATH` / `codex logged in` | Install Codex and run `codex login` (manual: user's subscription) |
| `model id …` missing | Check `~/.codex/models_cache.json` (`models[].slug`). The cache lists models a newer CLI may still reject, so confirm with `codex exec --skip-git-repo-check --sandbox read-only --model <id> "Reply OK"`. Then change `claude/global/config/models.json` (all machines: commit and push) or `models.local.json` (this machine only), and redeploy. The preflight reads the required ids from that config |
| `QUOTA GATE: BLOCKED … quota unknown` on every run | Neither `codex app-server` (`account/rateLimits/read`) nor a recent rollout in `~/.codex/sessions` gave a 5h window. Run `codex-delegate.mjs quota` to see the source errors; check `codex login`, or set `CODEX_BIN` if `codex` is not on PATH |
| `model config` | `models.json` / `models.local.json` is invalid (bad JSON, unknown role, missing model, effort outside `none…xhigh`); the message names the file and role |
| OpenAI `codex` Claude plugin not found | Install OpenAI's `codex` plugin (codex-plugin-cc) in Claude Code / the desktop app (manual). If it lives somewhere unusual, set the env var `CODEX_COMPANION` to the full path of `codex-companion.mjs` |
| `codex mcp-server available` | Codex Dispatch could work. Add the server to Claude's MCP config only if the user wants it; the wrapper doesn't need it |
| Not Windows | Nothing to change. The wrapper and installer are cross-platform Node; the `PowerShell(...)` permission rules are simply unused |

---

## 6. Validation (run in a session started after install)

From the kit root:

```bash
node claude/global/test/create-playground.mjs playground
```

**A. Luna implementation.** Expect `status: completed`, `GIT GUARD: OK`. Then verify it yourself: `git -C playground diff` stays within `src/strings.js` and `test/strings.test.js`, and `node --test` inside `playground` passes all tests.
```bash
node ~/.claude/orchestration/scripts/codex-delegate.mjs run --role luna-implement --packet claude/global/test/T001-slugify.yaml --cwd playground
```
Also test it through the subagent: ask Claude to *"delegate claude/global/test/T001-slugify.yaml to luna-worker with --cwd playground"*.

**B + C. Blind Astra review in background.** Expect `BLIND REVIEW: stripped non-allowed packet keys: rationale`, a `DELEGATE: run=<run-id>` line, a companion job ID, and no `CANARY` text in the prompt file under `~/.claude/orchestration/runs/`.
```bash
node ~/.claude/orchestration/scripts/codex-delegate.mjs run --role astra-review --packet claude/global/test/R001-slug-registry.yaml --cwd playground --background --reason "validation" --task-type design_review
```
```bash
node ~/.claude/orchestration/scripts/codex-delegate.mjs collect R001-slug-registry-astra-review --wait --timeout-ms 540000
```
Expect:
- a REVIEW_CONTRACT yaml with `verdict: revise` (on the first machine, Astra found that the singleton design breaks "stable across rebuilds");
- `GIT GUARD: OK`;
- `show R001-slug-registry-astra-review` reporting `status: completed` and a real `duration_ms` (~90 s, not ~1 s).

**E. Telemetry.**
- In the A run's `show` output, the first changed file should read `src/strings.js` (not `rc/strings.js`). If the playground already had an untracked file, it should appear in `dirty_before`.
- Attempt budget: re-run A with `--budget-key t:impl --max-attempts 1 --dry-run` after a real run that used the same key. Expect exit 4 and `orchestration budget exceeded`.
- Quota gate: `node ~/.claude/orchestration/scripts/codex-delegate.mjs quota` should print `source=live` and one verdict per role. `node --test claude/global/test/quota-gate.test.mjs` covers thresholds, reservations and exit 5 without calling Codex.
- `assess <run-id> --outcome accepted --useful yes ...`, `record-skip --task-id x --reason y`, `runs` and `metrics` should all succeed.
- Afterwards, move the validation records out of the evaluation window: put the files in `~/.claude/orchestration/runs/` into `runs/_validation/` and those in `telemetry/` into `telemetry/_validation/`.

**D. Forbidden git action.** Expect `status: blocked` and `GIT GUARD: OK`.
```bash
node ~/.claude/orchestration/scripts/codex-delegate.mjs run --role luna-implement --packet claude/global/test/T002-forbidden-git.yaml --cwd playground --effort low
```
Then prove the guard itself works: run `git -C playground branch guard-test`, then `verify-git <T002 baseline>` (expect `VIOLATION`, exit 3), then `git -C playground branch -D guard-test`.

---

## 7. Manual actions and known gotchas

Manual (Claude can't or shouldn't do these):
- Authenticate Codex (`codex login`) and install the OpenAI `codex` plugin in Claude if missing.
- Optional: disable the **Codex Dispatch** plugin in the desktop app while `codex mcp-server` is unavailable.
- Optional: run `codex/BOOTSTRAP.md` inside Codex if you also want named Codex profiles. This setup doesn't need them, since the wrapper passes the model per run.
- Codex's own default model (`model =` in `~/.codex/config.toml`; `gpt-6-astra` on the first machine) applies to `/codex:rescue`, `/codex:review` and `codex-review:*`, but never to the wrapper roles.

Gotchas seen on the first machine:
- **`npm` was not on the PATH Codex's shell uses**, so `npm test` failed inside Codex. Put Node's folder on PATH, or write `node --test`-style commands in `required_checks`.
- **Agents and `CLAUDE.md` load only at session start.** After install, open a new session.
- **The companion's broker process keeps the target repo as its working directory** until the Claude session ends, so on Windows that folder can't be deleted mid-session (`Device or resource busy`). `create-playground.mjs` accepts an existing empty folder for this reason.
- The Bash tool has a 10-minute limit. Use `--background` for anything that might take longer.
- Read-only Codex can still *read* files anywhere on disk. Blind review keeps Astra blind by limiting what is sent, not by isolating the filesystem.
- `DEP0190` deprecation warnings from the companion and git CRLF warnings are harmless.
- Running Astra on a repo while Luna is editing it lets Astra see half-finished state. Review after implementation finishes.
- Foreground runs now capture output and print it when Codex finishes, not live. The Bash tool only shows output at the end anyway.
- Runs submitted in the background before the telemetry extension have no job ID and can't be collected; use `result` + `verify-git` for those.
- Telemetry can't measure tokens or quota (the companion doesn't expose them).

## 8. Backend change (2026-10): `codex exec` by default

Sections 1–7 describe the original companion-based setup. Since roadmap step 3 the wrapper defaults to `codex exec`:

- **Why:** the companion script's install path is undocumented and moved between desktop versions (runs failed with "companion not found", one result was lost with "No job found"). The companion also needs the Codex CLI itself (it spawns `codex app-server`), so it never was a CLI-free path.
- **Invocation:** `codex exec --json --skip-git-repo-check -s <role sandbox> -m <model> -c model_reasoning_effort=<effort> -c approval_policy=never -C <cwd> -o <job>/last-message.txt -`, with the unchanged prompt file on stdin. No shell is used anywhere; npm's `codex.cmd` shim is refused with a hint to set `CODEX_BIN`.
- **Jobs:** each run gets `<run>.job/` with `spec.json`, `state.json` (atomic writes; `pending → running → completed|failed|cancelled`), `events.jsonl`, `stderr.txt`, `last-message.txt` and `cancel.request` when cancelling. A detached `exec-runner.mjs` supervises the Codex process. Foreground runs submit and wait, so a killed wrapper leaves a job that `collect` finalizes.
- **Result:** one normalization decides the status. Completed means exit 0, at least one `turn.completed` and no `turn.failed`/`error` event. Usage-limit messages give `failure_hint: quota`.
- **Telemetry gains:** `codex_usage` (input, cached, output, reasoning tokens) per run, and `exec.{thread_id, failures, warnings, reasons}`. `collect` is idempotent: it never re-snapshots a finalized run, and it locks finalization per run (the lock follows its owner's PID).
- **Commands:** `status|result|cancel <run-id | exec:<run-id>>` act on exec jobs; anything else passes through to the companion. `which` reports both. `--backend companion` (or `ORCH_BACKEND=companion`) selects the old path; there's no automatic fallback.
- **Known:** on Windows the detached runner inherits the caller's stdout pipe, so `run --background | …` blocks until the job ends. Redirect to a file instead. The companion had the same behaviour.
