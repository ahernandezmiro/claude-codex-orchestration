# Example Workflows

## Feature development

1. Opus reads requirements.
2. Opus writes feature spec + acceptance criteria.
3. For significant features, Astra independently reviews spec.
4. Opus revises/synthesizes.
5. Opus emits bounded implementation packet.
6. Luna implements.
7. Luna runs tests.
8. Opus reviews diff/results.
9. Astra reviews only if risk/size warrants it.

## 2D asset pipeline

1. Opus defines visual grammar, semantic SVG layers, palette/stroke constraints.
2. Astra challenges pipeline for editability/scalability/import concerns.
3. Opus locks pipeline.
4. Luna writes SVG generators/exporters/validators.
5. Opus visually reviews samples.

## 3D pipeline

1. Opus defines staged Blender production workflow.
2. Astra reviews topology/rigging/deformation/import assumptions.
3. Luna implements Blender Python helpers and validators.
4. Opus/Astra review failures only at stage boundaries.

## Video pipeline

1. Opus defines script/shot/storyboard intermediate representation.
2. Astra reviews continuity and production-control risks.
3. Luna implements Remotion components and rendering utilities.
4. Opus performs visual/story synthesis.
