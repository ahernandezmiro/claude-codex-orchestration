# Role prompts, prompt overrides and managed instruction blocks

Date: 2026-10-22. Status: approved design, awaiting spec review.

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

The opening identity and orchestrator lines are removed. The `worker` field is removed from `ROLES`. Each `ROLES` entry gains `defaultPrompt` (a file name under `prompts/roles/`) and keeps `contract`. `sol-implement` points at its own default file, a copy of the `luna-implement` text, so each role can be overridden on its own.

**`prompts/base.md`.** Rules that apply to every role, stated once:
- Git: read-only inspection only. No commit, push, merge, rebase, reset, checkout of other branches, tag, stash, remote changes or history rewrite. The orchestrator checks git state afterwards.
- Stay inside the packet: edit only files under `editable_paths`. If the packet has no `editable_paths`, or the sandbox is read-only, make no edits. Don't add dependencies, and don't change CI, manifests or global configuration, unless the packet authorizes it.
- If the task can't be done within scope, or the packet conflicts with the repository, stop and report `blocked` or `partial` with the reason. Don't redesign to get around it.

**`prompts/roles/*.md` defaults.** Each file says only what is specific to that role, with no identity heading and no file references:
- `luna-implement` / `sol-implement`: the priority order (invariants → acceptance criteria → minimal scope → existing patterns → testable/reversible), run `required_checks`, add or update tests when the packet asks.
- `luna-test`: act as an independent validator, make no production-code edits on the first pass, add isolated tests only if the packet allows. Report the failing command, expected vs actual, a minimal reproduction, the likely subsystem and a confidence level.
- `astra-review`: be independent of the author, don't assume the artifact is correct, don't optimise for agreement, and don't rewrite merely to differ. Review dimensions: requirements coverage, hidden assumptions, edge cases, unnecessary complexity, simpler alternatives, coupling, performance, failure modes, testability, reversibility. For code, also: API compatibility, migration risk, races, error handling, regression surface, test gaps. Use `focus` when the packet gives it. Make no edits.
- `astra-investigate`: separate symptom from cause, propose the smallest viable repair, note architectural implications, define validation steps. Return a repair plan and make no edits.

**`prompts/contracts/*.md`.** Only the YAML schema the worker must return, plus at most one line of instruction:
- `task.md`: `status, summary, files_changed, checks_run[{command,result}], unresolved_issues, risks, follow_up` (unchanged keys, so `parseWorkerReport` keeps working).
- `review.md`: `verdict, critical_findings, important_findings, minor_findings, alternatives[{name,tradeoffs}], recommended_questions_for_author` (unchanged).
- `result.md`: `status, summary, files_changed, commands_run, checks{passed,failed}, risks, unresolved, recommended_next_action`, with `role` and `model` dropped. This is safe: `parseWorkerReport` and `metrics` don't read either key from the report (checked 2026-10-22). Both values are already in the run record.

The 2D/3D/video checklists stay in `shared/REVIEW_CONTRACT.md` and `shared/CREATIVE_PIPELINE_RULES.md` as orchestrator-side guidance. When Opus writes a creative review packet, it copies the relevant points into `focus`, or the project overrides `astra-review.md`. Add one sentence to the "Review discipline" part of `claude/CLAUDE.md` saying this.

**Removed files:** `codex/AGENTS.md`, `codex/ROLE_*.md`, `codex/RESULT_CONTRACT.md`. The `section()` helper is deleted if nothing else uses it.

**Orchestrator-side docs:** `shared/TASK_CONTRACT.md` keeps the packet format (it's what Opus writes). Its `## Rules` and `## Completion report` sections are replaced by one line pointing to `codex/prompts/base.md` and `codex/prompts/contracts/task.md`, so the schema exists in one place. `shared/REVIEW_CONTRACT.md` keeps its inputs, dimensions and creative checklists; its output schema is replaced by a pointer to `codex/prompts/contracts/review.md`. The `output:` block is removed from `templates/task-packet.yaml`.

### 2. Role prompt resolution

For role `R`, the wrapper uses the first file that exists:

1. **Project:** `<project>/.orchestration/roles/R.md`, where `<project>` is the nearest directory with `.orchestration/` found by `findProjectConfig`'s upward walk (stopping at the git top-level). The walk now stops at the first `.orchestration/` that contains `project.json` **or** a `roles/` directory, so a project can override prompts without a `project.json`.
   - For `astra-*` roles, the project file is used only when that project's `project.json` sets `review_safe: true`. Otherwise it is ignored, and the run prints `ROLE PROMPT: project override for R ignored (review_safe is not true)`.
2. **Global:** `~/.claude/orchestration/overrides/roles/R.md`. `overrides/` is user data: it is not in the installer's `MANAGED_DIRS`, deploys leave it alone, and `--uninstall` keeps it unless `--purge` is passed (the same treatment as `runs/`).
3. **Kit default:** `~/.claude/orchestration/codex/prompts/roles/<defaultPrompt>`.

Rules:
- The override replaces part 2 only. Base rules, contract, packet and closing line are always added by the wrapper.
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

- Markers: `<!-- BEGIN orchestration-kit:<id> -->` and `<!-- END orchestration-kit:<id> -->`, each on its own line. `id` matches `[a-z0-9-]+`.
- **Legacy pair:** a line starting `<!-- BEGIN frontier-orchestration` and the line `<!-- END frontier-orchestration -->` are treated as the `claude-md` block and replaced by the new markers on the next upsert.
- `upsertBlock`:
  - exactly one well-formed pair (new or legacy): replace everything from BEGIN to END inclusive;
  - no markers: append the block, separated from existing content by exactly one blank line (an empty file gets just the block);
  - an unmatched BEGIN or END, more than one pair, or a pair nested inside another: throw an error naming the file, the problem and the line numbers. The installer then writes nothing to that file and exits non-zero.
- `removeBlock`: removes the pair and collapses the blank lines around it to at most one. Malformed markers produce the same errors as in `upsertBlock`. If no block is present, it returns `changed: false`.
- Line endings: if the input contains `\r\n`, the output uses `\r\n` throughout the block; otherwise `\n`. Text outside the block is preserved byte for byte.
- The installer writes the file and makes a backup only when `changed` is true. This also applies to `settings.json` (back up and write only if the merged JSON differs).

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
1. Append to an empty file.
2. Append to a non-empty file: exactly one blank line between existing content and the block.
3. Replace an existing block; bytes outside the block are unchanged.
4. Migrate the legacy `frontier-orchestration` pair.
5. Unmatched BEGIN → error with a line number.
6. Unmatched END → error.
7. Two pairs → error.
8. Nested pair → error.
9. CRLF input keeps CRLF.
10. Upsert with identical body → `changed: false`.
11. `removeBlock` removes the block and collapses blank lines; it is a no-op when no block is present.

**`role-prompts.test.mjs`** (dry-run, staged layout like `prompt-freeze.mjs`)
12. No overrides → default source; prompt equals the golden.
13. Global override → `source: global`; the override text replaces the role part.
14. Project override wins over global.
15. Project override with no `project.json` is found.
16. `astra-review` project override without `review_safe: true` → ignored, global or default used, warning printed.
17. `astra-review` project override with `review_safe: true` → used.
18. With an override, the base rules, contract and closing line are still present, verbatim.
19. Empty override → exit 2. An override over 64 KiB → exit 2.
20. Unknown file in `roles/` → warning, no failure.
21. Run record has `role_prompt {source, path, sha256}`; `config --explain` shows the same.
22. An old run record without `role_prompt` loads in `show` and `metrics`.

**Installer (`install.test.mjs`, temp `HOME`)**
23. Fresh install writes the 3-line block.
24. Second install → no write, no backup.
25. Install over a legacy 82-line block → migrated to the 3-line block.
26. Malformed markers → install exits non-zero and the file is unchanged.
27. `overrides/` survives reinstall and uninstall, and is removed only with `--purge`.

**Prompt-size report:** `prompt-freeze.mjs --update` prints old and new byte counts per role, and the change summary records them.

## Risks

- **Dropping the creative checklists** from the default reviewer prompt could weaken 2D/3D/video reviews if Opus forgets to put them in `focus`. Mitigation: the `claude/CLAUDE.md` sentence (§1), and a project override for creative repos.
- **Recursive `@` import:** if Claude Code ever stopped following nested imports, the routing policy would disappear without warning. Mitigation: check this manually after deploy by asking a new session about rule 6 of the routing policy. The same check applies to today's setup.
- **A user override can drop role-specific guidance** (for example, luna-test's "no production edits"). This is intended. The protected parts are only the base rules, contract, sandbox and git guard.
