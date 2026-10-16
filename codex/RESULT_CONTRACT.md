# Result Contract

All delegated Codex tasks should end with a compact structured report.

```yaml
status: completed | partial | blocked
role: luna-implement | luna-test | astra-review | astra-investigate
model: actual-model-id
summary: ...
files_changed: []
commands_run: []
checks:
  passed: []
  failed: []
risks: []
unresolved: []
recommended_next_action: ...
```

For review roles, `files_changed` should normally be empty on the first pass.
