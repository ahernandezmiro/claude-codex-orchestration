# Model Routing Policy

## Primary roles

### Opus 5.5 — Primary orchestrator / lead
Use for:
- product requirements and specification writing
- architecture and system design
- GDD / feature design
- task decomposition
- ambiguous or cross-cutting debugging
- UI/UX direction
- 2D/3D/video pipeline design
- synthesis of competing proposals
- final review/sign-off

Do not waste Opus by default on:
- mechanical edits
- repetitive refactors
- boilerplate
- routine test implementation
- straightforward implementation from a complete approved spec

### GPT-6 Luna — Default worker
Use for:
- bounded feature implementation
- tests from explicit acceptance criteria
- mechanical refactors
- migrations
- import/export tooling
- validators
- SVG asset variants from an established visual grammar
- Blender/Remotion support scripts
- deterministic asset-pipeline code

Escalate away from Luna when:
- two materially different attempts fail
- task boundaries are unclear
- implementation requires redesigning architecture
- changes span many coupled subsystems
- model repeatedly violates stated invariants

### GPT-6 Sol — Optional intermediate escalation
Use only if configured and useful in practice.
Suggested role:
- harder implementation than Luna
- medium-depth repo investigation
- implementation rescue before Astra

Do not make Sol mandatory. It is an optional tier.

### GPT-6 Astra — Independent reviewer / alternative-design specialist
Use for:
- third-party review of Opus feature designs
- architecture challenge
- alternative solution generation
- hidden-assumption discovery
- complex GDD/mechanics critique
- 2D production-pipeline review
- 3D modelling/rigging/animation pipeline review
- Remotion/video-pipeline review
- difficult algorithmic or systemic debugging
- high-impact implementation review

Astra should normally be treated as an independent counterparty, not merely a stronger Luna.

## Default routing by phase

| Phase | Primary | Secondary / review |
|---|---|---|
| Requirements | Opus | Astra for important/ambiguous work |
| Architecture | Opus | Astra independent review |
| Feature design / GDD | Opus | Astra independent proposal/review |
| Implementation | Luna | Sol/Astra only on escalation |
| Tests | Luna | Opus reviews test strategy for critical systems |
| Debugging | Opus or Luna depending scope | Astra for hard systemic issues |
| Code review | Opus | Astra for high-risk changes |
| 2D pipeline | Opus | Astra review; Luna implements tooling |
| 3D pipeline | Opus | Astra review; Luna implements tooling |
| Video pipeline | Opus | Astra review; Luna implements tooling |

## Independent review rule

For important work, do NOT give Astra the full Opus conversation or Opus hidden reasoning.
Give Astra only:
- original requirements
- constraints
- final proposal/artifact
- relevant repository/docs/assets

Ask Astra to:
- challenge assumptions
- identify missing requirements
- identify unnecessary complexity
- identify failure modes
- propose alternatives
- state trade-offs

Then give Astra's review back to Opus for synthesis.

## Escalation ladder

1. Luna attempts bounded implementation.
2. Luna may self-correct once if failure is local and objective.
3. If still blocked, Opus diagnoses whether the issue is spec ambiguity or implementation difficulty.
4. If implementation difficulty: optionally route to Sol.
5. If architectural/systemic/novel: route to Astra.
6. Opus owns final synthesis and scope control.

## Review severity policy

Astra review is recommended when any of these are true:
- architecture changes
- public API changes
- save/data model changes
- concurrency/networking/security implications
- difficult game-system interactions
- production asset pipeline changes
- large 2D/3D/video automation changes
- change touches >3 major subsystems
- change would be costly to undo later
