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
| `claude/global/config/models.local.json` | optional per-machine override (gitignored) | same, if present |
| `claude/global/agents/*.md` | `luna-worker`, `astra-reviewer` subagents | `~/.claude/agents/` |
| `claude/global/CLAUDE.orchestration.md` | orchestrator instructions | managed block in `~/.claude/CLAUDE.md` |
| `claude/global/settings.permissions.json` | allow/ask rules | merged into `~/.claude/settings.json` |
| `claude/global/install.mjs` | cross-platform installer | — |
| `claude/global/test/` | validation packets, playground creator, prompt-freeze guard + golden prompts | — |
| `deploy.ps1` / `deploy.sh` | deploy entry points for Windows / Linux-WSL | — |

## Deploy (fresh install or update)

Prerequisites on each machine: Node.js 18+, Codex CLI logged in (`codex login`), and OpenAI's `codex` plugin installed in Claude Code.

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

## Prompt freeze (evaluation period)

Telemetry compares delegations over time, so the prompts must not change while model and effort selection does. `node claude/global/test/prompt-freeze.mjs` checks two things:
- **Worker prompts:** it runs the wrapper in `--dry-run` for all five roles in a temporary copy of the installed layout, with a stub companion and no real telemetry. Each prompt must be byte-identical to `claude/global/test/golden/<role>.golden.md`.
- **Orchestrator and subagent prompts:** every prompt file Claude or a subagent loads must match `golden/static-prompts.sha256.json`.

The golden files were generated from the unmodified original kit, and the `luna-implement` golden matches a prompt recorded in production. The deploy scripts run the guard first and refuse to install on drift. `.gitattributes` forces LF endings because Git for Windows' `core.autocrlf` would otherwise rewrite the inlined prompt text.

When the evaluation is closed and prompts may change: edit them, run `node claude/global/test/prompt-freeze.mjs --update`, review the diff of `golden/`, commit, and deploy.

## What is not tracked

`.gitignore` excludes delegation runs and telemetry (`runs/`, `telemetry/`, `*.run.json`, `*.prompt.md`, `*.jsonl`, …), `.orchestration/` work products, playgrounds, Claude/Codex session and conversation state (`.claude/`, `.codex/`, transcripts), installer backups (`*.bak-*`), per-machine `models.local.json`, and editor/OS files. Only setup sources belong in the repo.
