# Creative Pipeline Rules

These rules reflect the intended workflow for project assets.

## 2D

Prefer deterministic / editable production:
- SVG
- programmatic vector generation
- layered source assets
- procedural geometry
- reusable palettes and style tokens

Avoid making diffusion-generated raster output the default source of truth.

Preferred pipeline:
requirements -> visual grammar -> reusable components -> asset variants -> validation -> engine import

## 3D

Treat the LLM as a production controller, not as an autonomous character artist.

Preferred stages:
1. requirements / proportions
2. blockout
3. mesh construction
4. validation
5. retopology if needed
6. rigging
7. deformation validation
8. animation clips
9. export/import validation

Use machine-checkable validation wherever possible.

Character modelling, rigging, and animation should receive stricter human/model review than environmental blockouts and props.

## Video

Prefer code-controlled production (e.g. Remotion-like workflows) over opaque one-shot generation.

Preferred stages:
script -> shot list -> storyboard -> asset plan -> scene spec -> render -> visual QA -> revision

Maintain explicit continuity state for:
- character appearance
- props
- camera axis
- lighting
- scene geography
- prior/next shot constraints

The goal is control and reproducibility, not single-prompt output quality.
