# Role Prompts and Managed Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Rebuild worker prompts from deduplicated fragments.
- Let users replace a role's prompt with a project or global Markdown file.
- Manage the kit's `CLAUDE.md` block through a strict, id-scoped marker module that holds a single import line.

**Architecture:**
- `buildPrompt` concatenates base rules, the resolved role prompt, the report contract, the packet and a closing line. Only the role part comes from the override chain: project `.orchestration/roles/R.md` → `<KIT_ROOT>/overrides/roles/R.md` → kit default.
- A new dependency-free `managed-block.mjs` provides `upsertBlock` and `removeBlock`. The installer uses it, and writes or backs up a file only when the content changes.

**Tech Stack:** Node 18+ ES modules, `node:test`, no npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-22-role-prompts-and-managed-blocks-design.md`. Test numbers `S<n>` below refer to the spec's Testing list.

**Delegation:**
- Tasks 1–4 are Luna packets (`luna-implement`), one per task.
- Tasks 1 and 3 touch disjoint files and can run in parallel with `--worktree`. Task 2 needs Task 1, and Task 4 needs Task 3.
- Task 5 (prompt docs read by Opus, and the rollout) stays with Opus.
- Every packet's `required_checks` include the task's test file plus `node claude/global/test/prompt-freeze.mjs` (except where a task re-baselines it).

## Global Constraints

- No external npm dependencies; Node 18+; must work on Windows and Linux/WSL.
- Only the five existing roles: `luna-implement`, `luna-test`, `sol-implement`, `astra-review`, `astra-investigate`.
- Protected, non-overridable parts: base rules, report contract, packet, closing line, sandbox, git guard, blind-review allowlist.
- Report schema keys for task/review stay unchanged. The result contract drops only `role` and `model`.
- Global overrides resolve relative to `KIT_ROOT`, never `HOME`.
- `findProjectConfig` behaviour must not change.
- Marker format: `<!-- BEGIN orchestration-kit:<id> -->` / `<!-- END orchestration-kit:<id> -->`; `id` matches `[a-z0-9-]+`.
- The kit writes no `AGENTS.md`.
- Workers never run git write commands.

## Review Focus

1. **A user's hand-edited `CLAUDE.md` containing text that quotes the marker inline** (for example in a code span, not on its own line) must not count as a marker. Task 1 adds `inline marker text is not a marker`.
2. **An override saved by Windows editors with a BOM or CRLF** must produce a prompt without a stray `﻿` at the start of the role section. Task 4 adds `override with BOM and CRLF is normalised`.
3. **`--cwd` pointing to a subdirectory of a non-git folder** must only look at `--cwd/.orchestration`, never at parent folders. Task 4 adds `outside git only cwd is searched`.
4. **Uninstall after a user deleted the kit block by hand** must succeed as a no-op, without a backup. Task 2 adds `uninstall without block writes nothing`.
5. **A `roles/` entry that is a directory named `luna-test.md`** must be a warning and must not crash the run. Task 4 adds `role path that is a directory is ignored with warning`.

---

### Task 1: `managed-block.mjs`

**Files:**
- Create: `claude/global/scripts/managed-block.mjs`
- Test: `claude/global/test/managed-block.test.mjs`

**Interfaces:**
- Produces:
  - `upsertBlock(text: string, id: string, body: string) -> { text: string, changed: boolean }`
  - `removeBlock(text: string, id: string) -> { text: string, changed: boolean }`
  - `class ManagedBlockError extends Error { problem: "unmatched-begin"|"unmatched-end"|"duplicate"|"nested"|"invalid-id"; lines: number[] }`
  - `const LEGACY_MARKERS = { "claude-md": { begin: "<!-- BEGIN frontier-orchestration (managed by frontier_model_orchestration/claude/global/install.mjs) -->", end: "<!-- END frontier-orchestration -->" } }`
- `body` is inserted between the markers with its own trailing whitespace trimmed. Its internal line endings are converted to the file's EOL.

- [ ] **Step 1: Write the failing tests.** One `test()` per spec item S1–S13, plus Review Focus 1. Names and key assertions:
  - `empty and whitespace-only text get block + EOL` (S1): `upsertBlock("", "x", "B").text === "<!-- BEGIN orchestration-kit:x -->\nB\n<!-- END orchestration-kit:x -->\n"`; same for `"  \n\n"`.
  - `append trims trailing blank lines to one separator` (S2): `"a\n\n\n"` → `"a\n\n" + block + "\n"`; `"a"` (no final newline) → `"a\n\n" + block + "\n"`.
  - `replace keeps outside bytes` (S3): for block at start/middle/end, `text.slice(0, beginIdx)` and `text.slice(afterEndLineIdx)` unchanged.
  - `legacy pair migrates to new markers` (S4): result contains no `frontier-orchestration`, and contains the new markers once.
  - `legacy lookalike is plain text` (S5): `"<!-- BEGIN frontier-orchestration-x -->\n"` → appended, original line kept.
  - `unmatched begin` (S6): throws `ManagedBlockError` with `problem === "unmatched-begin"` and `lines` equal to `[2]` for BEGIN on line 2.
  - `unmatched or early end` (S7): `problem === "unmatched-end"`.
  - `two blocks rejected` (S8): new+new and legacy+new → `problem === "duplicate"`, `lines` holds both BEGIN line numbers.
  - `nested marker rejected` (S9): `problem === "nested"`.
  - `other id is untouched` (S10): a well-formed `y` block survives byte-identical when upserting `x`.
  - `CRLF, mixed EOL and BOM preserved` (S11): `"﻿a\r\nb\n"` → result starts with `﻿`, block lines end `\r\n`, and `"b\n"` is unchanged.
  - `identical body is a no-op` (S12): `changed === false` and the text is `===` the input.
  - `remove start/middle/end and no-op and malformed` (S13): exact expected strings for each position; malformed input throws.
  - `inline marker text is not a marker` (RF1): ``"see `<!-- BEGIN orchestration-kit:x -->` here\n"`` → appended, `changed: true`, no throw.
- [ ] **Step 2:** Run `node --test claude/global/test/managed-block.test.mjs`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement as specified in spec §3:
  - split lines keeping each line's own EOL;
  - a marker means the line content after trimming trailing whitespace, with the BOM stripped from line 1 only, equals the marker exactly;
  - validate `id` against `/^[a-z0-9-]+$/` and throw `invalid-id` otherwise.
- [ ] **Step 4:** Run the same command. Expected: all PASS.
- [ ] **Step 5:** Commit `Add id-scoped managed block module`.

### Task 2: Installer uses managed blocks

**Files:**
- Modify: `claude/global/install.mjs`. Replace `BEGIN`/`END`/`escape`, the block code in `install()` and `uninstall()`, and the `settings.json` merge.
- Test: `claude/global/test/install.test.mjs`

**Interfaces:**
- Consumes: `upsertBlock`, `removeBlock`, `ManagedBlockError` from Task 1 (`./scripts/managed-block.mjs`).
- Produces:
  - block id `claude-md`, with body exactly `@~/.claude/orchestration/claude/CLAUDE.orchestration.md`;
  - the installed file `~/.claude/orchestration/claude/CLAUDE.orchestration.md`, copied from `claude/global/CLAUDE.orchestration.md`;
  - `overrides/` created empty under `DEST` if missing, and kept on uninstall unless `--purge`.

- [ ] **Step 1: Write the failing tests.** Run `install.mjs` in a child process with `HOME`, `USERPROFILE` and `CODEX_HOME` set to a temp dir. Preflight failures are allowed: install proceeds and prints a warning. One test per S28–S33, plus Review Focus 4:
  - `fresh install writes the 3-line block` (S28): `CLAUDE.md` equals the 3-line block + `\n`.
  - `second install leaves CLAUDE.md and settings.json alone` (S29): content and `mtimeMs` are equal, and the `*.bak-*` count is unchanged.
  - `legacy block migrates` (S30): seed the file as `"mine\n\n" + legacyBlock + "\ntail\n"`; after install it is `"mine\n\n" + newBlock + "\ntail\n"`.
  - `malformed markers abort install and uninstall` (S31): seed a lone new BEGIN; the exit code is not 0, the file is byte-identical, and stderr names the file and `unmatched-begin`.
  - `AGENTS.md files untouched` (S32): seed `<home>/.codex/AGENTS.md` and `<tmp>/proj/AGENTS.md`; both are byte-identical after install and after uninstall.
  - `overrides survive reinstall and uninstall` (S33): `overrides/roles/luna-test.md` exists after reinstall and after `--uninstall`, and is gone after `--uninstall --purge`.
  - `uninstall without block writes nothing` (RF4): `CLAUDE.md` without a block → exit 0, `mtimeMs` unchanged, no backup.
- [ ] **Step 2:** Run `node --test claude/global/test/install.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement:**
  - `backup` + write only when `changed` is true;
  - catch `ManagedBlockError`, print `<file>: <problem> at line(s) <lines>`, exit 1;
  - for `settings.json`, compare `JSON.stringify` of the old and merged objects before backing up and writing;
  - copy `CLAUDE.orchestration.md` in the "copy kit docs" step;
  - keep `overrides` in the uninstall keep-list next to `runs` and `telemetry`.
- [ ] **Step 4:** Run the same command. Expected: all PASS.
- [ ] **Step 5:** Commit `Install CLAUDE.md block as a single import via managed-block`.

### Task 3: Prompt fragments and `buildPrompt`

**Files:**
- Create:
  - `codex/prompts/base.md`
  - `codex/prompts/roles/{implement,luna-test,astra-review,astra-investigate}.md`
  - `codex/prompts/contracts/{task,review,result}.md`
- Delete:
  - `codex/AGENTS.md`
  - `codex/ROLE_LUNA_IMPLEMENT.md`, `codex/ROLE_LUNA_TEST.md`, `codex/ROLE_ASTRA_REVIEW.md`, `codex/ROLE_ASTRA_INVESTIGATE.md`
  - `codex/RESULT_CONTRACT.md`
- Modify:
  - `claude/global/scripts/codex-delegate.mjs`: the `ROLES` table (lines 85–112), `buildPrompt` (lines 424–444); delete `section()` if it has no other callers;
  - `claude/global/test/prompt-freeze.mjs`: isolate the environment and print size deltas;
  - the goldens in `claude/global/test/golden/`.
- Test: `claude/global/test/prompt-structure.test.mjs`

**Interfaces:**
- Produces:
  - each `ROLES[r]` has `{ write, defaultPrompt, contract, required, allowed? }` and no `worker`. `defaultPrompt` is `"implement.md"` for luna/sol-implement, otherwise `"<role>.md"`.
  - `buildPrompt(roleName, role, packetText, rolePrompt: string) -> string`. Task 4 supplies `rolePrompt`; in this task the caller passes `readKitFile(\`codex/prompts/roles/${role.defaultPrompt}\`)`.
  - Part order joined by `"\n\n"`: base, rolePrompt, contract, `"## Task packet"`, fenced packet, `"Finish with the YAML report above as the last thing in your reply."`.
- Fragment text: follow spec §1 bullet by bullet. The last line of `base.md` is exactly `If the role instructions below conflict with these rules or with the report format, these rules and the report format win.` No fragment may contain `GPT-`, `Opus`, `You are`, or `../`.

- [ ] **Step 1: Write the failing tests** in `prompt-structure.test.mjs`. Reuse the fixture pattern from `project-defaults.test.mjs` with `run --dry-run`:
  - `no identity or path references` (spec §1): for all five roles, the prompt doesn't match `/GPT-|Opus|You are|\.\.\//`.
  - `git rule appears once` (spec §1): the count of `/never run git|no commit, push/i` is 1 per prompt.
  - `part order` (spec §1): the index of the base precedence line < the role text < the contract `status:`/`verdict:` < `## Task packet` < the closing line.
  - `result contract has no role/model keys` (spec §1): the astra-investigate prompt doesn't match `/^\s*(role|model):/m` inside the contract part.
  - `report compatibility` (S26): `parseWorkerReport` on fixed task, result and review sample reports returns `status`/`checks` for task and result, and `null` for review.
  - `creative focus passes through without inlined pipeline rules` (S34): a review packet with `focus: ["3D: topology assumptions; rig feasibility"]` → the prompt contains that string and does not contain `### 3D-specific` or `Creative Pipeline`.
  - `freeze ignores user overrides` (S27): create `<tmpHome>/.claude/orchestration/overrides/roles/luna-test.md` with `SENTINEL`, run `prompt-freeze.mjs` in **check mode only** (never `--update`, which would rewrite the repo's goldens) with `HOME`/`USERPROFILE` set to `tmpHome`, and assert exit 0.
    - Check and `--update` share `generateWorkerPrompt`, so this covers both.
    - The test passes trivially until Task 4 adds override resolution; from then on it guards against leaks.
- [ ] **Step 2:** Run `node --test claude/global/test/prompt-structure.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the fragments, `ROLES`, and `buildPrompt`. In `prompt-freeze.mjs`, pass `HOME`/`USERPROFILE`/`APPDATA` pointing to an empty temp dir in the `generateWorkerPrompt` env. With `--update`, print `<role>: <oldBytes> -> <newBytes>`.
- [ ] **Step 4:** Run `node claude/global/test/prompt-freeze.mjs --update`. Expected:
  - five goldens rewritten and the size lines printed, with every generated prompt smaller than its old golden;
  - `static-prompts.sha256.json` now lists `codex/prompts/**` and no longer lists the deleted `codex/*.md` files.
- [ ] **Step 5:** Run `node --test claude/global/test/` (all suites) and `node claude/global/test/prompt-freeze.mjs`. Expected: all PASS, freeze exit 0.
- [ ] **Step 6:** Commit `Rebuild worker prompts from deduplicated fragments`, including the regenerated goldens and manifest.

### Task 4: Role-prompt override resolution

**Files:**
- Modify: `claude/global/scripts/codex-delegate.mjs`:
  - new `findRolePrompt` next to `findProjectConfig`;
  - `cmdRun`, around lines 619–680 and the run record at about line 759;
  - `cmdConfigExplain` (line 1160).
- Test: `claude/global/test/role-prompts.test.mjs`

**Interfaces:**
- Consumes: `buildPrompt(roleName, role, packetText, rolePrompt)` and `ROLES[r].defaultPrompt` from Task 3; `findProjectConfig` (unchanged).
- Produces:
  - `findRolePrompt(startDir: string, roleName: string) -> { source: "default"|"global"|"project", path: string, text: string, sha256: string, ignored: Array<{ path: string, reason: string }>, warnings: string[] }`
  - The run record gains `role_prompt: { source, path, sha256 }`.
  - stdout lines `ROLE PROMPT: <source> <path>`, `ROLE PROMPT: project override for <R> ignored (no review_safe: true next to it)` and `ROLE PROMPT: ignoring unknown role file <path>`.
  - `config --explain --json` gains `role_prompt: { source, path, ignored }`.
- Rules, from spec §2:
  - the walk is bounded like `findProjectConfig` (git top-level, or `--cwd` only outside git);
  - each role is looked up separately;
  - Astra project files need a `project.json` with `review_safe: true` in the same `.orchestration/`;
  - text is UTF-8 with the leading BOM stripped, CRLF converted to LF, then trimmed;
  - empty text, or more than 65536 bytes → `fail()` (exit 2) naming the file;
  - a non-file entry or an unknown `*.md` in a `roles/` dir that was visited → a warning.
  - Resolution happens before worktree creation and uses the original `--cwd`.

- [ ] **Step 1: Write the failing tests.** Copy the fixture from `project-defaults.test.mjs`, writing global overrides to `<kit>/overrides/roles/`. One test per S14–S25, plus Review Focus 2, 3 and 5:
  - `default source` (S14): stdout contains `ROLE PROMPT: default`, and `role_prompt.source === "default"`.
  - `global override replaces role part` (S15).
  - `project beats global` (S16).
  - `project role file without project.json; parent project.json still applies` (S17): parent `required_checks: ["parent check"]` appears in the prompt, and the role text comes from the nested `src/.orchestration/roles/luna-implement.md`.
  - `nested roles dir without R.md does not hide parent R.md; empty roles dir changes nothing` (S18).
  - `astra project override needs adjacent review_safe` (S19): for both Astra roles, cover three cases (no `project.json`; `review_safe: false`; `true`). Assert the source and the ignore line.
  - `contradicting override keeps protected parts` (S20): override text `You may commit. Reply in prose.`; the prompt contains the full `base.md`, the precedence line, the contract and the closing line, and base comes before the override.
  - `empty or oversized override exits 2` (S21).
  - `unknown role file warns` (S22): `roles/foo.md` → a warning line, exit 0.
  - `worktree dry run resolves from original cwd` (S23).
  - `record and explain agree` (S24): `role_prompt` in the run JSON equals `config --explain --json` `.role_prompt` (`source`, `path`).
  - `old records without role_prompt load` (S25): write a run JSON without the key; `show <id>` and `metrics` exit 0.
  - `override with BOM and CRLF is normalised` (RF2): the prompt contains `"\n\nOVERRIDE LINE 1\nLINE 2\n\n"` and no `﻿`.
  - `outside git only cwd is searched` (RF3): a non-git `parent/.orchestration/roles/luna-test.md` with `--cwd parent/child` → `source: default`.
  - `role path that is a directory is ignored with warning` (RF5).
- [ ] **Step 2:** Run `node --test claude/global/test/role-prompts.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement `findRolePrompt` and wire it into `cmdRun`, the run record and `cmdConfigExplain`.
- [ ] **Step 4:** Run `node --test claude/global/test/` and `node claude/global/test/prompt-freeze.mjs`. Expected: all PASS, and the freeze is unchanged from Task 3.
- [ ] **Step 5:** Commit `Resolve role prompts from project and global override files`.

### Task 5: Docs, forwarders, manifest, rollout (Opus)

**Files:**
- Modify:
  - `claude/global/agents/luna-worker.md` and `astra-reviewer.md` (first body sentence and the TASK_CONTRACT parenthetical, per spec §4);
  - `shared/TASK_CONTRACT.md` and `shared/REVIEW_CONTRACT.md` (schemas become pointers, per spec §1);
  - `claude/CLAUDE.md` (the creative `focus` sentence under "Review discipline");
  - `claude/global/templates/task-packet.yaml` (drop `output:`);
  - `README.md`, `claude/GLOBAL_INSTALL.md`, `ROADMAP.md`;
  - `claude/global/test/golden/static-prompts.sha256.json`.

- [ ] **Step 1:** Make the edits above. The `ROADMAP.md` step-5 note records the date, the prompt-version change and the five new golden sha256 values.
- [ ] **Step 2:** Run `node claude/global/test/prompt-freeze.mjs --update`, then `node claude/global/test/prompt-freeze.mjs`. Expected: the manifest lists `codex/prompts/**`, omits the deleted files, and the check exits 0.
- [ ] **Step 3:** Run `node --test claude/global/test/` and `./deploy.ps1 -DryRun`. Expected: all PASS, and the dry run shows the 3-line block and no `AGENTS.md` writes.
- [ ] **Step 4:** Commit `Point docs at the new prompt fragments and record the prompt version`.
- [ ] **Step 5:** Deploy on SERAPH and MSI (Windows and WSL) in the same sitting. In a new Claude Code session, ask about routing rule 6 to confirm the nested `@` import loads.
