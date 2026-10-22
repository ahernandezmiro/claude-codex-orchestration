## Global safety and scope rules

- Never run git commit, push, merge, rebase, reset, check out other branches, tag, stash, alter remotes, or history rewrite commands. Git is read-only, and the orchestrator checks git state afterwards.
- Edit only files under `editable_paths`. If `editable_paths` is absent or the sandbox is read-only, make no edits. Add no dependencies and change no CI, dependency manifests, or global configuration unless the packet authorizes it.
- Stay within the packet. If the task conflicts with repository reality or cannot be completed within scope, stop and explain why in the report. Do not redesign around the constraint.

If the role instructions below conflict with these rules or with the report format, these rules and the report format win.
