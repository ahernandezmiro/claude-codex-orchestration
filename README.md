# orchestration-kit

<!-- Repo overview for the Claude Opus + Codex (Luna/Sol/Astra) orchestration kit.
     Author: maintained with Claude Code for the frontier-model orchestration setup. -->

This repo is the source of truth for the multi-model orchestration setup: Claude Code (Opus) orchestrates, and Codex workers (Luna, Sol, Astra) are reached through `codex-delegate.mjs`. You edit, commit and push it here, then pull and run the deploy script on each machine (Windows hosts, WSL distros, other devices).

The kit itself is documented in [claude/GLOBAL_INSTALL.md](claude/GLOBAL_INSTALL.md) (architecture, validation, gotchas) and [shared/README.md](shared/README.md) (policy).

## Layout

| Path | What it is | Installed to |
|---|---|---|
| `shared/`, `codex/`, `claude/*.md` | policy, contracts and role docs (prompt text) | `~/.claude/orchestration/{shared,codex,claude}/` |
| `claude/global/scripts/codex-delegate.mjs` | delegation wrapper: roles, prompt assembly, git guard, telemetry | `~/.claude/orchestration/scripts/` |
| `claude/global/config/models.json` | **model + default effort per role** | `~/.claude/orchestration/config/` |
| `claude/global/config/quota.json` | **quota-gate threshold per role** | same |
| `claude/global/scripts/quota-gate.mjs` | Codex quota read + gate, used by the wrapper | `~/.claude/orchestration/scripts/` |
| `claude/global/scripts/pack-telemetry.mjs` | zips runs + telemetry for offline analysis | `~/.claude/orchestration/scripts/` |
| `claude/global/scripts/telemetry-lib.mjs` | schema-2 attribution: working-tree snapshots, worker/post-worker diff stats, report parsing, `metrics --by` | same |
| `claude/global/scripts/opus-usage.mjs` | offline: Claude tokens spent between each worker result and its assessment, from local session transcripts | same |
| `claude/global/scripts/exec-backend.mjs`, `exec-runner.mjs` | default backend: shell-free `codex exec` resolution and argv, detached job runner with atomic state, event normalization, verified cancel | same |
| `claude/global/templates/project.json` | example per-project defaults (`<repo>/.orchestration/project.json`) | `~/.claude/orchestration/templates/` |
| `claude/global/config/models.local.json` | optional per-machine override (gitignored) | same, if present |
| `claude/global/agents/*.md` | `luna-worker`, `astra-reviewer` subagents | `~/.claude/agents/` |
| `claude/global/CLAUDE.orchestration.md` | orchestrator instructions | managed block in `~/.claude/CLAUDE.md` |
| `claude/global/settings.permissions.json` | allow/ask rules | merged into `~/.claude/settings.json` |
| `claude/global/install.mjs` | cross-platform installer | — |
| `claude/global/test/` | validation packets, playground creator, prompt-freeze guard + golden prompts, quota-gate and packer tests | — |
| `deploy.ps1` / `deploy.sh` | deploy entry points for Windows / Linux-WSL | — |

## Deploy (fresh install or update)

Prerequisites on each machine: Node.js 18+ and the Codex CLI logged in (`codex login`). On Windows the wrapper needs the real `codex.exe` on PATH (the standalone installer provides it); with only npm's `codex.cmd` shim, set `CODEX_BIN` to the executable or the package's JS entry. OpenAI's `codex` Claude plugin is optional: it's only used with `--backend companion`.

Windows (PowerShell):
```powershell
git clone <remote> $env:USERPROFILE\dev\orchestration-kit
Set-Location $env:USERPROFILE\dev\orchestration-kit
.\deploy.ps1 -Check
.\deploy.ps1
```

Linux / WSL:
```bash
git clone <remote> ~/dev/orchestration-kit && cd ~/dev/orchestration-kit
./deploy.sh --check
./deploy.sh
```

To update later, run `git pull` and then the deploy script again. Start a new Claude Code session afterwards, because agents and `CLAUDE.md` only load at session start.

What a deploy does:
1. Finds Node 18 or newer. `deploy.sh` also checks `$NODE_BIN_DIR`, pnpm, Volta and nvm, because non-interactive WSL shells often only see an old `/usr/bin/node`.
2. Runs the prompt-freeze guard and aborts if any prompt changed (see below).
3. Runs `install.mjs`:
   - preflight checks;
   - deletes and re-copies the kit-managed folders (`shared, codex, claude, scripts, templates, config`), so removed files disappear too;
   - installs the agents;
   - replaces the managed `CLAUDE.md` block;
   - merges the permission rules (`CLAUDE.md` and `settings.json` are backed up first);
   - writes `~/.claude/orchestration/deployed.json` (commit, dirty flag, host, effective models).
4. Prints the effective model selection.

`runs/` and `telemetry/` are never touched. Other options: `-DryRun`/`--dry-run`, `-Uninstall [-Purge]`/`--uninstall [--purge]`, `-AllowPromptChange`/`--allow-prompt-change`.

## Model configuration

`claude/global/config/models.json` maps each role to a Codex model id and a default reasoning effort:

```json
{ "roles": { "luna-implement": { "model": "gpt-6-luna", "effort": "high" }, "...": {} } }
```

- **Change models for every machine:** edit `models.json`, commit, push, pull on each machine, deploy.
- **Change one machine only:** create `claude/global/config/models.local.json` in that machine's checkout. It's gitignored and has the same shape, but any subset of roles and fields is allowed. Then deploy.
- **Check a machine:** `node ~/.claude/orchestration/scripts/codex-delegate.mjs models`.
- **Valid efforts:** `none, minimal, low, medium, high, xhigh`. `--effort` on a single run still overrides the default.
- **Bad config fails loudly.** An unknown role, a missing model, an invalid effort or invalid JSON stops `run` with a message naming the file. The wrapper never falls back to a built-in model.
- **Check the model works first.** The Codex cache can list models your account or CLI still rejects. Before switching, run `codex exec --skip-git-repo-check --sandbox read-only --model <id> "Reply OK"`.

Roles themselves (prompt, sandbox, contract, required packet keys, blind-review allowlist) stay in `codex-delegate.mjs` and are not configurable. In particular, the worker display name in the prompt ("You are GPT-6 Luna…") is part of the frozen prompt and does not follow the model id.

## Project defaults

A project can add rules to every packet it receives without touching the kit. Create `<repo>/.orchestration/project.json`; `templates/project.json` is an example. The wrapper looks for it from `--cwd` up to the git root, using the main checkout even for `--worktree` runs.

- `constraints`, `required_checks`: appended to every Luna/Sol packet. Packets must use block lists (`key:` followed by `- item` lines); flow lists like `[]` are rejected so nothing gets silently dropped.
- `context`: added to task packets as a `project_context:` block. Astra packets get it only with `"review_safe": true`, and never get the constraints or checks.
- `roles.<role>.model` / `.effort`: override `config/models.json` for that project. `--effort` on the command line still wins.
- Strictly append-only: sandbox, git rules, the blind-review allowlist and the frozen prompt text can't be changed. Invalid files stop the run (exit 2) and name the file.
- Each run records `project_config` (file, sha256, what was applied), `model_source`/`effort_source`, and `prompt_sha256`, so runs with and without project defaults stay comparable.
- Check what applies: `node ~/.claude/orchestration/scripts/codex-delegate.mjs config --explain <role> --cwd <repo> [--json]`.

## Quota gate

Every real `run` (not `--dry-run`) checks Codex quota before it delegates, so a worker doesn't start and then stop with partial or empty results. The check is a script, so the orchestrator doesn't decide anything: the call either goes ahead or exits with code **5** before any Codex work starts.

How it works:
1. It reads the 5h window (`window_minutes: 300`) from a short-lived `codex app-server` (`account/rateLimits/read`, the numbers `/status` shows; about 2–3 s). If that fails, it uses the newest `rate_limits` snapshot in `~/.codex/sessions` rollouts, as long as that window hasn't reset. If neither gives a value, the run is blocked.
2. It reserves quota for runs still in flight: runs recorded as `running` or `submitted_background` that started within the last window. Each one reserves its role's number from `config/quota.json`.
3. It allows the run only if `(100 − used%) − reservations − this role's number > 0`.

| Role | Threshold = reservation |
|---|---|
| `astra-review`, `astra-investigate` | 25 |
| `sol-implement` | 15 |
| `luna-implement`, `luna-test` | 10 |

Example: 60% remaining with one Astra and one Luna in flight leaves 60 − 25 − 10 = 25%. Astra (needs more than 25) is blocked; Sol and Luna are allowed.

- A blocked call prints `QUOTA GATE: BLOCKED …`, writes a `quota_gate_blocked` event to `telemetry/events.jsonl` and creates no run record. An allowed call stores the verdict in the run record as `quota_gate`.
- `codex-delegate.mjs quota [--role <role>] [--json]` shows the current verdict for each role.
- Uncollected background runs keep their reservation until they are collected or a window has passed. Run `collect` promptly.
- Environment variables: `CODEX_BIN` sets the codex binary. `CODEX_QUOTA_SNAPSHOT=<file.json>` (`{usedPercent, windowMinutes, resetsAt}`) replaces the live read; the tests use it.
- Tests: `node --test claude/global/test/quota-gate.test.mjs`.

## Exporting telemetry for analysis

`pack-telemetry.mjs` writes one zip with everything the evaluation produced on a machine:

```bash
node ~/.claude/orchestration/scripts/pack-telemetry.mjs
```

- **Where it reads:** `<home>/.claude/orchestration`, the root `install.mjs` deploys to: `%USERPROFILE%\.claude\orchestration` on Windows, `~/.claude/orchestration` on Linux/WSL. `--source <dir>` (repeatable) packs other dirs instead.
- **Both sides of a Windows + WSL machine:** `--all-hosts` adds every WSL distro's `/home/*/.claude/orchestration` when run on Windows (via `\\wsl.localhost`; this boots a stopped distro), or every `/mnt/<drive>/Users/*/.claude/orchestration` when run in WSL.
- **What goes in:** `manifest.json` (sources, file/run/event counts, options), then one folder per source (`<host>-<platform>-<user>/`) with `runs/`, `telemetry/`, `deployed.json` and `config/*.json`. Kit files (scripts, prompts, templates) are not included.
- **Trimming:** `--exclude-raw` drops `*.prompt.md`, `*.stdout.txt` and `*.stderr.txt`, which can hold project code; run records and events keep every metric. `--exclude-validation` drops `runs/_validation/` and `telemetry/_validation/`.
- **Output:** `./orchestration-telemetry-<host>-<timestamp>.zip`, or `--out <file.zip>`. `--dry-run` prints the summary without writing. Zips are gitignored.
- Tests: `node --test claude/global/test/pack-telemetry.test.mjs`.

## Prompt freeze (evaluation period)

Telemetry compares delegations over time, so the prompts must not change while model and effort selection does. `node claude/global/test/prompt-freeze.mjs` checks two things:
- **Worker prompts:** it runs the wrapper in `--dry-run` for all five roles in a temporary copy of the installed layout, with a stub companion and no real telemetry. Each prompt must be byte-identical to `claude/global/test/golden/<role>.golden.md`.
- **Orchestrator and subagent prompts:** every prompt file Claude or a subagent loads must match `golden/static-prompts.sha256.json`.

The golden files were generated from the unmodified original kit, and the `luna-implement` golden matches a prompt recorded in production. The deploy scripts run the guard first and refuse to install on drift. `.gitattributes` forces LF endings because Git for Windows' `core.autocrlf` would otherwise rewrite the inlined prompt text.

When the evaluation is closed and prompts may change: edit them, run `node claude/global/test/prompt-freeze.mjs --update`, review the diff of `golden/`, commit, and deploy.

## What is not tracked

`.gitignore` excludes delegation runs and telemetry (`runs/`, `telemetry/`, `*.run.json`, `*.prompt.md`, `*.jsonl`, …), `.orchestration/` work products, playgrounds, Claude/Codex session and conversation state (`.claude/`, `.codex/`, transcripts), installer backups (`*.bak-*`), telemetry exports (`orchestration-telemetry-*.zip`), per-machine `models.local.json`, and editor/OS files. Only setup sources belong in the repo.
