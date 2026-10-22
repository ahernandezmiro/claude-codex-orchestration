# Task Contract

Every delegated task should be converted into a bounded task packet before execution.

## Required fields

```yaml
id: unique-task-id
role: implement | test | investigate | design | review | asset-pipeline
objective: >-
  One concrete outcome.

context:
  files: []
  docs: []
  assets: []

editable_paths: []
read_only_paths: []

constraints:
  - explicit invariant
  - explicit invariant

acceptance_criteria:
  - observable condition
  - observable condition

required_checks:
  - command or validation step

out_of_scope:
  - explicitly excluded work
```

## Worker rules and report

The worker-side rules and the completion report schema are defined once, in `codex/prompts/base.md` and `codex/prompts/contracts/task.md`. The wrapper adds both to every Luna/Sol prompt, so packets don't repeat them.
