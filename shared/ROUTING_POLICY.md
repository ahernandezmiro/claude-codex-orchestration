# Model Routing Policy

## Primary roles

### Opus 5.5 — Primary orchestrator / lead
Use for:
- product requirements and specification writing
- architecture and system design
- GDD / feature design
- task decomposition
- ambiguous or cross-cutting debugging
- discovering unknown behaviour (reverse engineering, undocumented formats, original game rules) before any implementation packet
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
- implementing behaviour that is already established (decoded rules, reference outputs, a written spec)

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

## Evidence-based rules (from the 2026-10 telemetry, 141 runs)

These rules apply on top of the tables below. Each one names the evidence it came from, so it can be revised when new data disagrees.

1. **Packet size: aim for a 5–15 minute worker run.** If you expect a packet to take longer than about 15 minutes, split it into sequential packets with their own acceptance criteria. *Evidence:* Luna runs of 5–15 min had 52% accepted, 15–30 min runs 29%.
2. **Spec review before multi-packet phases.** Before dispatching a phase of two or more implementation packets, get a blind Astra review of the phase spec. *Evidence:* Gordi had no Astra reviews and 30% accepted. Midnight Tavern's phases without a spec review had 0 of 7 accepted; later phases with one did better. Reviews take about 4 minutes.
3. **Discovery stays with Opus.** Don't hand Luna a packet whose correct behaviour is unknown, such as undecoded game rules or unverified formats. Opus (with Astra for hard cases) establishes the behaviour first, then Luna implements it. *Evidence:* the first Gordi reconstructions needed major rework because mechanics were invented; once Opus supplied the decoded rules, the rebuilds were mostly accepted.
4. **Engine work needs a runtime smoke test.** Packets for Godot/Unity/Unreal or other integrated apps must include a `required_checks` entry that starts the engine or app and exercises the changed flow (headless run, autoplay bot, scene load). Unit tests alone don't count as acceptance. Put it in the project's `.orchestration/project.json` so every packet gets it. *Evidence:* Midnight Tavern p4/p6 passed unit tests while the integrated game was broken.
5. **Algorithm-heavy work starts with a feasibility spike.** For DSP and other numerically hard features, first dispatch a short spike packet with a measurable pass/fail target (for example latency, error bound or an eval-harness score), then the full implementation. Consider Sol for the core algorithm when Luna's spike stubs it. *Evidence:* rtmod p2a stubbed the PSOLA core; Sol implemented it from a pseudocode-level spec.
6. **One test per acceptance criterion.** Write criteria so each one maps to a test, and check that mapping in review. A missing test is a `test_gap`, even when the worker reports `completed`. *Evidence:* every 2026-10 test-gap rework (c1, d4, d2, f5, worktree-isolation attempt 1) was fixed by a second pass that only added the missing tests.

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
