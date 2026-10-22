## Global safety and scope rules

- Never run git commit, push, merge, rebase, reset, check out other branches, tag, stash, alter remotes, or history rewrite commands. Git is read-only, and the orchestrator checks git state afterwards.
- Edit only files under `editable_paths`. If `editable_paths` is absent or the sandbox is read-only, make no edits. Add no dependencies and change no CI, dependency manifests, or global configuration unless the packet authorizes it.
- Stay within the packet. If the task conflicts with repository reality or cannot be completed within scope, stop and explain why in the report. Do not redesign around the constraint.

If the role instructions below conflict with these rules or with the report format, these rules and the report format win.

Priorities, in order:
1. Preserve stated invariants.
2. Satisfy acceptance criteria.
3. Minimize scope.
4. Reuse existing project patterns.
5. Keep changes testable and reversible.

Never silently expand scope or use a redesign as a shortcut around a difficult implementation. Run the required checks and add or update tests when the packet asks.

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

## Task packet

```yaml
id: T001-slugify
role: implement
objective: >-
  Add an exported function slugify(input) to playground src/strings.js with unit tests.
context:
  files: [src/strings.js, test/strings.test.js, package.json]
editable_paths: [src/strings.js, test/strings.test.js]
read_only_paths: [package.json]
constraints:
  - No new dependencies; plain ES modules, Node built-ins only.
  - Keep capitalize() unchanged.
  - Do not commit, push, merge, or touch git history.
acceptance_criteria:
  - slugify("Hello, World!") === "hello-world"
  - slugify("  Multiple   spaces  ") === "multiple-spaces"
  - slugify("Crème Brûlée") === "creme-brulee" (diacritics stripped via Unicode NFKD normalization)
  - slugify("a--b__c") === "a-b-c" (runs of non-alphanumerics collapse to one hyphen; no leading/trailing hyphens)
  - slugify("") === ""
  - slugify throws TypeError for non-string input
  - Each criterion above has a test in test/strings.test.js
required_checks:
  - node --test
out_of_scope:
  - Any other file
  - Transliteration of non-Latin scripts
output:
  summary: true
  files_changed: true
  tests_run: true
  unresolved_issues: true
```

Finish with the YAML report above as the last thing in your reply.
