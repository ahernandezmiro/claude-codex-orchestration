# Independent Review Contract

Use this for Astra or any independent reviewer.

## Inputs

Reviewer receives:
- original requirements
- explicit constraints
- relevant source/assets/docs
- final artifact/proposal/diff

Reviewer should NOT receive the producing model's hidden reasoning or persuasive narrative unless needed for a specific audit.

## Review dimensions

1. Requirements coverage
2. Hidden assumptions
3. Missing edge cases
4. Unnecessary complexity
5. Simpler alternatives
6. Coupling / maintainability
7. Performance implications
8. Failure modes
9. Testability / observability
10. Reversibility / migration cost
11. Domain-specific quality

### Coding-specific
- API compatibility
- data/schema migration risk
- race conditions / state bugs
- error handling
- regression surface
- test gaps

### 2D-specific
- procedural reproducibility
- editability
- semantic layers
- style grammar consistency
- export/import determinism
- avoiding unnecessary raster/diffusion dependencies

### 3D-specific
- topology assumptions
- rig/weight/deformation feasibility
- Blender automation robustness
- validation stages
- engine import compatibility
- separation of modelling, retopo, rigging, animation

### Video-specific
- storyboard representation
- continuity state
- deterministic timing/layout
- asset provenance
- shot-to-shot coherence
- ability to revise without regenerating everything

## Output format

```yaml
verdict: acceptable | revise | rethink
critical_findings: []
important_findings: []
minor_findings: []
alternatives:
  - name: ...
    tradeoffs: ...
recommended_questions_for_author: []
```

The reviewer does not make edits during the first review pass unless specifically asked.
