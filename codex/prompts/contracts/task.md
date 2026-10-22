Return a YAML report with these keys:

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
