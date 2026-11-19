# Grading engine

The grade is plain JSON. It is validated, packed into a small GPU buffer, and evaluated by the
same WGSL in the viewer, the scopes and (later) the renderer. A CPU reference
(`applyGradeCPU`) mirrors the shader and backs the pixel probe, the tests and the exporters.

## Pipeline position

```
scene (ACEScg) → viewer exposure / saturation → GRADE → settings CDL → user LUT → view transform
```

The viewer exposure and saturation are viewing aids, applied before the grade. A render can
include or skip them.

## Model (`Grade`, version 1)

A grade is a list of nodes applied in series. Each node runs these stages in a fixed order:

| Stage      | Domain  | Parameters                                                                                                                                                                                                                       |
| ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linear     | ACEScg  | `exposure` (stops); `temperature` (K of the assumed illuminant, 6500 = neutral) and `tint` (±1 ≈ ±0.02 Duv), applied as a Bradford adaptation to the 6500 K Planckian white; `mixer` (3×3)                                       |
| Primaries  | ACEScct | applied as offset → contrast/pivot → lift/gain → gamma. Each wheel is `[r, g, b, master]`: lift and offset are additive, gain multiplies, gamma sets the exponent `2^-(g)`. Lift keeps 1.0 fixed, gain keeps 0, gamma keeps both |
| Log wheels | ACEScct | `shadows`, `midtones`, `highlights` (additive), weighted by luma; `lowRange` 0.333, `highRange` 0.55, transition 0.1                                                                                                             |
| CDL        | ACEScct | ASC CDL v1.2, no clamp                                                                                                                                                                                                           |
| Curves     | ACEScct | `r`, `g`, `b`, then `y` on all channels. Monotone cubic (no overshoot), extended outside [0, 1] with a constant offset                                                                                                           |
| HSL        | ACEScct | `hueHue` (turns), `hueSat`, `hueLum`, `lumSat`, `satSat`; the hue curves are periodic. Then node `saturation` and `hue` rotation, about AP1 luma and the grey axis                                                               |
| Mix        | ACEScct | `mix` blends the node output with its input                                                                                                                                                                                      |

The output of each node is clamped to an ACEScct range of −1 to 2, which is about −0.1 to 4e7
linear, so f32 values never overflow to Inf or NaN.

Identity parts cost nothing: identity nodes are dropped when the grade is packed, and identity
stages are skipped through per-node flags.

## GPU

The GPU runs a single interpreter function, `sl_grade` (`grade/wgsl.ts`). It loops over the
packed nodes and branches on uniform flags. Editing the grade, even adding or removing nodes,
never recompiles a pipeline; it only rewrites:

- a storage buffer of parameters: one header `vec4` plus 16 `vec4`s per node;
- an `r32float` curve table: 1024 samples, 9 rows per node, read with `textureLoad` and
  interpolated linearly.

**Cost** (M3 Pro, display pass on a 2340×1266 canvas, UHD ProRes):

- no grade: 0.6 ms;
- three nodes with every stage active: 2.4 ms;
- playback stays at 24 fps.

**GPU vs CPU:** `tools/grade-gpu-check.mts` (Dawn) runs 200 random grades over 515 samples each.
The worst difference is 2e-4 in ACEScct units (one 10-bit code value is about 1e-3). The e2e test
checks on-screen pixels against `applyViewCPU(probe.graded)` to within 2.5/255.

## API

```ts
player.setGrade(json, { history: true | false | 'drag-key' });
player.updateGradeNode(nodeId | null, { primaries: { contrast: 1.2 } }, { history: 'contrast' });
player.commitGradeEdit(); // on pointer up: end the coalesced undo step
player.undo();
player.redo();
player.getGrade(); // deep copy
player.gradeCPU([r, g, b]); // graded ACEScg, as the shader computes it
player.state.gradeRevision; // changes on every edit; also canUndo / canRedo
```

- **Undo:** edits that share a `history` key within 800 ms merge into one undo step.
- **Validation:** `normalizeGrade` accepts partial or foreign JSON, fills in defaults, drops
  unknown fields, makes duplicate node ids unique, and rejects newer versions.
- **Web component:** `el.getGrade()`, `el.setGrade(json)`, `el.undo()`, `el.redo()`, and a
  `gradechange` event whose `detail` is `{ grade }`.
- **Shortcuts:** ⌘Z / ⇧⌘Z (Ctrl on Windows and Linux).
