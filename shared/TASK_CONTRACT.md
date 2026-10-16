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

output:
  summary: true
  files_changed: true
  tests_run: true
  unresolved_issues: true
```

## Rules

- Delegated workers must not silently expand scope.
- If a task requires architectural changes outside the packet, stop and report the need for redesign.
- If a requested file is outside `editable_paths`, do not modify it without explicit approval.
- Do not commit, push, merge, rewrite history, or alter remote branches unless the task explicitly authorizes it.
- Do not modify CI, dependency manifests, engine-wide configuration, or global settings unless explicitly authorized.
- Prefer existing abstractions and dependencies over adding new ones.
- New dependencies require justification.

## Completion report

Every worker returns:

```yaml
status: completed | partial | blocked
summary: ...
files_changed: []
checks_run:
  - command: ...
    result: pass | fail | not-run
unresolved_issues: []
risks: []
follow_up: []
```
