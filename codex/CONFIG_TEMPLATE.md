# Codex Configuration Template

Do not copy this blindly over your existing config. Ask Codex to inspect its current schema and merge the equivalent settings.

Desired logical profiles:

```toml
# PSEUDOCONFIG — adapt to the schema supported by the installed Codex build.

[profiles.luna_worker]
model = "<LOCAL_LUNA_MODEL_ID>"
reasoning_effort = "high"
# sandbox/write permissions: project workspace only

[profiles.luna_test]
model = "<LOCAL_LUNA_MODEL_ID>"
reasoning_effort = "high"
# prefer read-only production source on first pass

[profiles.astra_review]
model = "<LOCAL_ASTRA_MODEL_ID>"
reasoning_effort = "high"
# sandbox = read-only
# prefer fresh session

[profiles.astra_investigate]
model = "<LOCAL_ASTRA_MODEL_ID>"
reasoning_effort = "high"
# broad read / diagnostic execution
# no writes unless explicitly approved
```

Optional:

```toml
[profiles.sol_worker]
model = "<LOCAL_SOL_MODEL_ID>"
reasoning_effort = "high"
```

The exact syntax may differ. The bootstrap agent must discover and adapt rather than overwrite unknown config.
