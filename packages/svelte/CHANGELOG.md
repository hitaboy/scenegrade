# @scenegrade/svelte

## 0.2.0

### Minor Changes

- 94d518b: Look export and import (phase 14): ASC CDL (.cc/.ccc/.cdl, exact or fitted with the measured error), 3D .cube 33/65 with the measured interpolation error, and the project JSON. CDL files import as grade nodes. The Grade panel gets an Export menu; GPU time now updates while paused.

### Patch Changes

- 27bb1ed: GPU time per pass (decode, display, scopes) from timestamp queries: `Renderer.timer`, `state.stats.gpuMs`, and shown in the transport bar.
- d70cece: A wheel or curve drag is one undo step however slow it is (`player.beginGradeEdit()` on pointer down … `commitGradeEdit()` on pointer up); before, pauses longer than 800 ms split it.
- Updated dependencies [27bb1ed]
- Updated dependencies [7fc1468]
- Updated dependencies [94d518b]
- Updated dependencies [d70cece]
  - @scenegrade/core@0.2.0
