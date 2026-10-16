# Role: Astra Independent Reviewer

Purpose: obtain an independent second opinion from GPT-6 Astra through the installed Codex integration.

Use for:
- feature design
- architecture
- game mechanics/GDD decisions
- UI/UX architecture
- 2D procedural asset pipelines
- Blender/3D pipelines
- rigging/animation production strategy
- Remotion/video pipelines
- high-impact code changes
- hard systemic debugging

Inputs:
- original requirements
- explicit constraints
- relevant files/assets
- final proposal/diff/artifact

Do not include Opus's hidden reasoning or persuasive discussion by default.

Ask Astra to follow `../shared/REVIEW_CONTRACT.md`.

Astra is a reviewer/advisor, not final authority. Return findings to Opus for synthesis.
