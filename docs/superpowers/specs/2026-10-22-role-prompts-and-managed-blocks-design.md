# Role prompts, prompt overrides and managed instruction blocks

Date: 2026-10-22. Status: approved. Revised after a blind Astra review (run `2026-10-22T10-35-59-367Z-R-role-prompts-spec-astra-review`, verdict `revise`; findings R2–R5 and all minors applied, R1 applied as a clarification).

## Goal

1. Worker prompts carry only what the worker needs for the task, with every rule stated once.
2. A user can replace a role's prompt with a Markdown file: a global file overrides the kit default, a project file overrides both.
3. The kit changes the user's `CLAUDE.md` as little as possible, through one marked block it can always find, replace or remove. It does not write `AGENTS.md`.

## Non-goals

- New roles, or roles defined by users. Only the existing five roles (`luna-implement`, `luna-test`, `sol-implement`, `astra-review`, `astra-investigate`) can be overridden.
- Partial overrides (`extends`, section merging, append mode). An override file replaces the whole role prompt.
- Overriding model, sandbox, required packet keys, the blind-review allowlist, base rules or report contracts.
- Plugin packaging, a `SessionStart` hook, `init-project`.
- Changes to routing policy content.

## Current problems (evidence)

From `buildPrompt` (`claude/global/scripts/codex-delegate.mjs`) and `test/golden/luna-implement.golden.md`:

- Identity text the model doesn't need: `You are GPT-6 Luna, acting in the … role of a multi-model orchestration`, `Claude Opus is the orchestrator…`, and role-doc headings `# GPT-6 Luna — Implementation Worker`.
- The git rule appears three times: the `codex/AGENTS.md` safety list, an extra git sentence in `buildPrompt`, and the `shared/TASK_CONTRACT.md` `## Rules` section. Scope and dependency rules also appear 2–3 times.
- References the worker can't resolve: `../shared/TASK_CONTRACT.md`, `../shared/REVIEW_CONTRACT.md`, `../shared/CREATIVE_PIPELINE_RULES.md`. Their content is already inlined, or isn't needed.
- Astra review prompts always include the full 2D/3D/video checklists and `CREATIVE_PIPELINE_RULES.md`, even for code reviews. They also include advice meant for the orchestrator ("Reviewer should NOT receive the producing model's hidden reasoning…").
- `codex/RESULT_CONTRACT.md` asks the worker for `role` and `model`, which the wrapper already records.
- `codex/AGENTS.md` is never installed as a Codex instruction file. The wrapper only slices one heading out of it with `section()`, which silently returns `""` if the heading is renamed.
- The `CLAUDE.md` managed block inlines all 82 lines of `CLAUDE.orchestration.md`. Every deploy backs the file up even when nothing changed. Unmatched or duplicate markers go undetected.

## Design

### 1. Prompt structure

`buildPrompt` assembles these parts in order, separated by blank lines:

| # | Part | Source (kit, under `codex/`) | Overridable |
|---|---|---|---|
| 1 | Base rules | `prompts/base.md` | no |
| 2 | Role prompt | resolved per §2; defaults in `prompts/roles/<role>.md` | yes |
| 3 | Report contract | `prompts/contracts/<task\|review\|result>.md` | no |
| 4 | `## Task packet` + fenced YAML packet | packet after blind-review stripping and project defaults (unchanged) | n/a |
| 5 | Closing line | `Finish with the YAML report above as the last thing in your reply.` | no |

The opening identity and orchestrator lines are removed. The `worker` field is removed from `ROLES`. Each `ROLES` entry gains `defaultPrompt` (a file name under `prompts/roles/`) and keeps `contract`. `luna-implement` and `sol-implement` share the default `implement.md`. They still have separate override file names, because overrides are always named after the role.

**`prompts/base.md`.** Rules that apply to every role, stated once:
- Git: read-only inspection only. No commit, push, merge, rebase, reset, checkout of other branches, tag, stash, remote changes or history rewrite. The orchestrator checks git state afterwards.
- Stay inside the packet: edit only files under `editable_paths`. If the packet has no `editable_paths`, or the sandbox is read-only, make no edits. Don't add dependencies, and don't change CI, manifests or global configuration, unless the packet authorizes it.
- If the task can't be done within scope, or the packet conflicts with the repository, stop and explain why in the report. Don't redesign to get around it. Each contract says how to show this: `status: blocked|partial` for task/result, the rule in `review.md` for reviews.
- Precedence (last line of the file): `If the role instructions below conflict with these rules or with the report format, these rules and the report format win.`

**`prompts/roles/*.md` defaults.** Each file says only what is specific to that role, with no identity heading and no file references:
- `implement.md` (`luna-implement`, `sol-implement`): the priority order (invariants → acceptance criteria → minimal scope → existing patterns → testable/reversible), run `required_checks`, add or update tests when the packet asks.
- `luna-test.md`: act as an independent validator, run the specified checks, inspect the changed behaviour, make no production-code edits on the first pass, add isolated tests only if the packet allows. Report the failing command, expected vs actual, a minimal reproduction, the likely subsystem and a confidence level.
- `astra-review`: be independent of the author, don't assume the artifact is correct, don't optimise for agreement, and don't rewrite merely to differ. Review dimensions: requirements coverage, hidden assumptions, edge cases, unnecessary complexity, simpler alternatives, coupling, performance, failure modes, testability, reversibility. For code, also: API compatibility, migration risk, races, error handling, regression surface, test gaps. Use `focus` when the packet gives it. Make no edits.
- `astra-investigate`: separate symptom from cause, propose the smallest viable repair, note architectural implications, define validation steps. Return a repair plan and make no edits.

**`prompts/contracts/*.md`.** Only the YAML schema the worker must return, plus at most one line of instruction:
- `task.md`: `status, summary, files_changed, checks_run[{command,result}], unresolved_issues, risks, follow_up` (unchanged keys, so `parseWorkerReport` keeps working).
- `review.md`: `verdict, critical_findings, important_findings, minor_findings, alternatives[{name,tradeoffs}], recommended_questions_for_author` (unchanged), plus one rule: `If you cannot complete the review, set the verdict you can support and list what is missing in recommended_questions_for_author.`
- `result.md`: `status, summary, files_changed, commands_run, checks{passed,failed}, risks, unresolved, recommended_next_action`, with `role` and `model` dropped. This is safe: `parseWorkerReport` and `metrics` don't read either key from the report (checked 2026-10-22). Both values are already in the run record.

The 2D/3D/video checklists stay in `shared/REVIEW_CONTRACT.md` and `shared/CREATIVE_PIPELINE_RULES.md` as orchestrator-side guidance. When Opus writes a creative review packet, it copies the relevant points into `focus`, or the project overrides `astra-review.md`. Add one sentence to the "Review discipline" part of `claude/CLAUDE.md` saying this.

**Removed files:** `codex/AGENTS.md`, `codex/ROLE_*.md`, `codex/RESULT_CONTRACT.md`. The `section()` helper is deleted if nothing else uses it.

**Orchestrator-side docs:** `shared/TASK_CONTRACT.md` keeps the packet format (it's what Opus writes). Its `## Rules` and `## Completion report` sections are replaced by one line pointing to `codex/prompts/base.md` and `codex/prompts/contracts/task.md`, so the schema exists in one place. `shared/REVIEW_CONTRACT.md` keeps its inputs, dimensions and creative checklists; its output schema is replaced by a pointer to `codex/prompts/contracts/review.md`. The `output:` block is removed from `templates/task-packet.yaml`.

### 2. Role prompt resolution

For role `R`, the wrapper uses the first file that exists:

1. **Project:** the nearest `.orchestration/roles/R.md`. A separate function, `findRolePrompt(startDir, R)`, looks for it by walking up from `--cwd` with the same bounds as `findProjectConfig`: it stops at the git top-level, or at `--cwd` itself outside git. **`findProjectConfig` doesn't change**, so a role file never hides a parent `project.json`. Each role is looked up separately, so a nearer `roles/` folder that lacks `R.md` doesn't hide a parent's `R.md`.
   - For `astra-*` roles, the project file is used only when the **same** `.orchestration/` directory contains a `project.json` that sets `review_safe: true`. Otherwise it is ignored, the search continues with the global file, and the run prints `ROLE PROMPT: project override for R ignored (no review_safe: true next to it)`.
2. **Global:** `<KIT_ROOT>/overrides/roles/R.md`, which is `~/.claude/orchestration/overrides/roles/R.md` when installed. The path is relative to `KIT_ROOT`, not `HOME`, so the prompt-freeze staging (a temp `KIT_ROOT` without `overrides/`) can never pick up a real user override. `overrides/` is user data: it is not in the installer's `MANAGED_DIRS`, deploys leave it alone, and `--uninstall` keeps it unless `--purge` is passed (the same treatment as `runs/`).
3. **Kit default:** `<KIT_ROOT>/codex/prompts/roles/<defaultPrompt>`.

Rules:
- The override replaces part 2 only. Base rules, contract, packet and closing line are always added by the wrapper.
- **Overrides are trusted customisation**, written by the user. The kit protects structure, not behaviour:
  - the protected parts are always present;
  - the base rules' precedence line resolves conflicts in their favour;
  - execution limits are still enforced only by the sandbox (read-only for Astra) and the git guard.

  An override that tells the worker to break the rules is unsupported, not prevented. The same goes for keeping author reasoning out of a global or `review_safe` project override for Astra: `review_safe` is the user's attestation, not a sanitiser.
- A missing or unparseable final report is handled as today: `report` is recorded as `null`, and Opus sees the raw output. This change doesn't alter that. `parseWorkerReport` currently extracts `status` and `checks_run` (task/result) only. Review reports parse to `null`, which is an existing limitation and out of scope.
- `astra-investigate` keeps having no packet allowlist (it isn't a blind review). This change doesn't touch packet stripping for any role.
- Content is read as UTF-8 and trimmed. An empty or whitespace-only override fails the run with exit 2 and names the file. An override larger than 64 KiB also fails with exit 2.
- Files in an override `roles/` directory whose name isn't `<known role>.md` cause a one-line warning per run (`ROLE PROMPT: ignoring unknown role file <path>`). They never cause a failure.
- With `--worktree`, resolution uses the original `--cwd` before the worktree is created, the same as `project.json` today.
- Every run prints `ROLE PROMPT: <source> <path>` (source = `default|global|project`).
- The run record gains `role_prompt: { source, path, sha256 }`. `prompt_sha256` is unchanged. Old records without `role_prompt` still load; readers treat it as `null`.
- `config --explain <role> [--cwd]` prints the resolved role-prompt source and path, plus any ignored overrides with the reason. With `--json`, these appear under `role_prompt`.

### 3. Managed instruction blocks

New module `claude/global/scripts/managed-block.mjs`, used by `install.mjs`. It has no dependencies.

```
upsertBlock(text, id, body) -> { text, changed }
removeBlock(text, id)       -> { text, changed }
```

- **Markers:** `<!-- BEGIN orchestration-kit:<id> -->` and `<!-- END orchestration-kit:<id> -->`. A marker is a line whose content, after trimming trailing whitespace, equals the marker exactly. `id` matches `[a-z0-9-]+`.
- **Legacy markers:** only for `id = "claude-md"`, and only as exact lines:
  - BEGIN: `<!-- BEGIN frontier-orchestration (managed by frontier_model_orchestration/claude/global/install.mjs) -->`
  - END: `<!-- END frontier-orchestration -->`

  They are held in a `LEGACY_MARKERS` table, so other ids have none. A legacy pair counts as an occurrence of the `claude-md` block.
- **Scanning:**
  - only markers for the target id (new or legacy) are structural;
  - any other id's markers, or lines that merely look like markers, outside the target block are ordinary text;
  - inside the target block, any `orchestration-kit:` or legacy marker line is an error (nested).
- **Errors** (thrown as `ManagedBlockError` with `problem` and 1-based `line` numbers; the installer adds the file path, writes nothing to that file, and exits non-zero):
  - BEGIN without END;
  - END before any BEGIN or without a BEGIN;
  - more than one target block, including one legacy plus one new;
  - a nested marker.
- **`upsertBlock`:**
  - one block: replace the lines from BEGIN to END inclusive. The line ending after END is kept as it was, and so is everything before BEGIN and after END.
  - no block: if the text is empty or whitespace-only, the result is `block + EOL`. Otherwise, trailing blank lines at the end of the text are removed, then `EOL + EOL + block + EOL` is appended. Those trailing blank lines are the only bytes outside the block that may change.
- **`removeBlock`:**
  - no block: `changed: false`;
  - otherwise remove the BEGIN–END lines and their line ending. If blank lines now meet across the gap, keep exactly one. At the start of the file, remove blank lines that follow. At the end of the file, remove blank lines that precede, and keep a final EOL only if the original had one after END.
  - These separator lines are the only bytes outside the block that may change.
  - Malformed markers raise the same errors, and the file stays unchanged.
- **Encoding:**
  - EOL is `\r\n` if the first line ending in the file is `\r\n`, otherwise `\n`; new block lines use that EOL;
  - a leading UTF-8 BOM is kept and ignored for scanning;
  - mixed line endings outside the block are left as they are.
- **Install writes:** the installer writes the file and makes a backup only when `changed` is true. This also applies to `settings.json` (back up and write only if the merged JSON differs).

**CLAUDE.md block** (id `claude-md`):

```
<!-- BEGIN orchestration-kit:claude-md -->
@~/.claude/orchestration/claude/CLAUDE.orchestration.md
<!-- END orchestration-kit:claude-md -->
```

The installer copies `claude/global/CLAUDE.orchestration.md` to `~/.claude/orchestration/claude/CLAUDE.orchestration.md`. Its existing `@` imports (`shared/ROUTING_POLICY.md`, `claude/CLAUDE.md`) keep working because Claude Code follows imports recursively. The file's own text doesn't change in this work.

**AGENTS.md:** the kit writes no `AGENTS.md`, global or project. Workers get their rules from the prompt. Codex still loads the target repo's own `AGENTS.md`, which stays entirely the user's. Any future feature that must write into an instruction file uses `managed-block.mjs` with its own `id`.

### 4. Claude-side forwarder agents

`luna-worker.md` and `astra-reviewer.md` keep their frontmatter, command and rules. Only the body's first sentence changes: from `You are a thin forwarder to GPT-6 Luna via Codex…` to `Forward one packet to the delegation wrapper. You do no engineering (review) work yourself.`. The `(YAML following shared/TASK_CONTRACT.md)` parenthetical is removed. Descriptions stay as they are, because Opus uses them to choose an agent.

### 5. Prompt freeze and rollout

- `test/prompt-freeze.mjs --update` regenerates the five worker goldens and updates the static manifest: `codex/prompts/**` is added, and the deleted files are removed. The manifest lists prompt text only, so code files such as `managed-block.mjs` stay out of it.
- Overrides are never part of the freeze. Runs that use them are identified by `role_prompt.source`.
- This change starts a new prompt version. `ROADMAP.md` step 5 gets a note with the date and the new golden hashes. Runs before and after are analysed separately, using `prompt_sha256` and `role_prompt.source`.
- Deploy to both machines (SERAPH and MSI, Windows and WSL) in the same sitting, so the batch doesn't mix versions per machine.
- Docs to update: `README.md` (layout table, override paths), `claude/GLOBAL_INSTALL.md` (managed block, overrides, `--purge` scope), and `ROADMAP.md` (the note above).

## Testing

Each item maps to one test, using `node --test` like the existing suites.

**`managed-block.test.mjs`**
1. Upsert into an empty file and into a whitespace-only file → `block + EOL`.
2. Upsert appends to a file with content: trailing blank lines are trimmed to exactly one blank line before the block. A file without a final newline gets one separator.
3. Replace an existing block at the start, middle and end of a file; bytes outside the block are unchanged.
4. Migrate the exact legacy pair to new markers.
5. A legacy-lookalike line (for example `<!-- BEGIN frontier-orchestration-x -->`) is plain text.
6. Unmatched BEGIN → error with its line number.
7. Unmatched END, or END before BEGIN → error.
8. Two blocks (new+new, and legacy+new) → error.
9. A nested marker inside the target block → error.
10. Another id's well-formed block is untouched; upsert of the target id appends beside it.
11. CRLF input gives CRLF block lines. Mixed EOLs outside the block are preserved. A BOM is preserved.
12. Upsert with an identical body → `changed: false`, text identical.
13. `removeBlock` at the start, middle and end follows the separator rules. With no block it is a no-op. With malformed markers it throws, and the text is unchanged.

**`role-prompts.test.mjs`** (dry-run, staged layout like `prompt-freeze.mjs`, isolated `HOME`/`USERPROFILE`)
14. No overrides → `source: default`; prompt equals the golden.
15. Global override (`<KIT_ROOT>/overrides/roles/R.md`) → `source: global`; the override text replaces the role part.
16. Project override wins over global.
17. A project override is found without a `project.json`, and the parent's `project.json` defaults (checks, model) still apply when the role file sits in a nested `.orchestration/`.
18. A nested `roles/` folder without `R.md` doesn't hide the parent's `R.md`. An empty `roles/` changes nothing.
19. `astra-review` and `astra-investigate` project overrides: ignored when the same `.orchestration/` has no `project.json`, or has one without `review_safe: true` (warning, falls through to global/default); used when it has `review_safe: true`.
20. With an override that contradicts the base rules ("you may commit", "reply in prose"), the base rules, precedence line, contract and closing line are all present verbatim, and the base rules come before the role part.
21. Empty override → exit 2. An override over 64 KiB → exit 2.
22. Unknown file in `roles/` → warning, no failure.
23. With `--worktree --dry-run`, resolution uses the original `--cwd`.
24. Run record has `role_prompt {source, path, sha256}`; `config --explain` (text and `--json`) shows the same, including ignored overrides.
25. An old run record without `role_prompt` loads in `show` and `metrics`.
26. Report compatibility: a representative final report for each contract parses as today (task and result: status and checks; review: `null`, as before).

**Prompt freeze**
27. A sentinel override placed in a simulated user home and in the real-`HOME` location doesn't appear in any generated golden, in both check and `--update` mode. Every generated prompt reports `ROLE PROMPT: default`.

**Installer (`install.test.mjs`, temp `HOME`/`USERPROFILE`)**
28. Fresh install writes the 3-line block.
29. Second install: `CLAUDE.md` and `settings.json` keep the same content and mtime, and no new `.bak-*` files appear. Managed directories and `deployed.json` are rewritten as before.
30. Install over a legacy 82-line block → migrated to the 3-line block. Text outside it is unchanged.
31. Malformed markers → install and uninstall both exit non-zero, and the file is byte-identical.
32. Existing `~/.codex/AGENTS.md` and a project `AGENTS.md` are byte-identical after install and uninstall.
33. `overrides/` survives reinstall and uninstall, and is removed only with `--purge`.
34. A representative creative-review packet whose `focus` carries the 3D checklist points produces a prompt containing that focus text and no inlined `CREATIVE_PIPELINE_RULES.md`.

**Prompt-size report:** `prompt-freeze.mjs --update` prints old and new byte counts per role, and the change summary records them.

## Risks

- **Dropping the creative checklists** from the default reviewer prompt could weaken 2D/3D/video reviews if Opus forgets to put them in `focus`. Mitigation: the `claude/CLAUDE.md` sentence (§1), and a project override for creative repos.
- **Recursive `@` import:** if Claude Code ever stopped following nested imports, the routing policy would disappear without warning. Mitigation: check this manually after deploy by asking a new session about rule 6 of the routing policy. The same check applies to today's setup.
- **A user override can drop role-specific guidance** (for example, luna-test's "no production edits"). This is intended. The protected parts are only the base rules, contract, sandbox and git guard.
