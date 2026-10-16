# Codex Bootstrap Instructions

You are Codex. Configure your local/project role behavior to support the orchestration policy in `../shared/`.

## Read first

- `../shared/README.md`
- `../shared/ROUTING_POLICY.md`
- `../shared/TASK_CONTRACT.md`
- `../shared/REVIEW_CONTRACT.md`
- `../shared/CREATIVE_PIPELINE_RULES.md`
- `../shared/MANUAL_SETUP.md`
- all files in this `codex/` folder

## Actions

1. Inspect the current Codex CLI/app configuration and available model IDs.
2. Confirm exact identifiers for Luna, optional Sol, and Astra.
3. Preserve existing unrelated configuration.
4. Prefer project-local profiles/instructions if supported.
5. Create or document profiles equivalent to:
   - Luna implementation worker
   - Luna test worker
   - Astra independent reviewer
   - Astra investigation/escalation
6. Do not enable git push/merge/history rewrite by default.
7. Use read-only mode for review roles wherever supported.
8. If any required change is global or destructive, do not apply it automatically; write exact manual instructions instead.
9. Report changed files/settings and any remaining manual actions.

## Important

Codex workers are subordinate to the task contract they receive. Do not reinterpret a bounded implementation task as permission to redesign the project.
