# Claude Code Bootstrap Instructions

You are Claude Code. Configure this project/workspace to use the orchestration policy in `../shared/`.

## Goal

Make Opus 5.5 the primary orchestrator while using installed Codex integration plugins to delegate bounded work to GPT-6 Luna and independent review/alternative-design work to GPT-6 Astra.

## Read first

- `../shared/README.md`
- `../shared/ROUTING_POLICY.md`
- `../shared/TASK_CONTRACT.md`
- `../shared/REVIEW_CONTRACT.md`
- `../shared/CREATIVE_PIPELINE_RULES.md`
- `../shared/MANUAL_SETUP.md`
- all files in this `claude/` folder

## Actions

1. Inspect the currently installed Claude Code plugins and identify the exact commands/agents exposed by:
   - OpenAI codex-plugin-cc
   - Anthropic Codex Dispatch
   - Anthropic codex-review
2. Do NOT assume command names from this package when plugin metadata says otherwise.
3. Create or update local project-level Claude instructions/agents so the routing policy is automatically followed.
4. Prefer project-local configuration over global configuration.
5. Preserve unrelated existing user configuration.
6. If a global change is required, stop and write the exact manual action needed instead of silently applying it.
7. Configure an explicit Luna worker role and Astra independent-review role using the installed Codex delegation facilities.
8. Make independent Astra review blind by default: requirements + artifact, not the producing model's prior reasoning transcript.
9. Add a rule preventing delegated workers from pushing/merging/rewriting Git history unless explicitly authorized.
10. Report exactly what files/settings you changed and what still requires manual action.

## Desired behavior

When the user gives a substantial task:
- Opus determines whether it needs design/spec work first.
- Opus writes/updates a task packet when delegation is useful.
- Routine bounded implementation/test tasks go to Luna.
- Important design/architecture/creative-pipeline work may get an Astra independent review.
- Opus synthesizes and owns the final answer/plan.

Do not delegate trivial work merely to satisfy the architecture.
