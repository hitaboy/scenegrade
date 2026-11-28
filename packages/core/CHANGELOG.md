# @scenegrade/core

## 0.2.0

### Minor Changes

- 94d518b: Look export and import (phase 14): ASC CDL (.cc/.ccc/.cdl, exact or fitted with the measured error), 3D .cube 33/65 with the measured interpolation error, and the project JSON. CDL files import as grade nodes. The Grade panel gets an Export menu; GPU time now updates while paused.

### Patch Changes

- 27bb1ed: GPU time per pass (decode, display, scopes) from timestamp queries: `Renderer.timer`, `state.stats.gpuMs`, and shown in the transport bar.
- 7fc1468: Video support (Mediabunny) is loaded on demand when a video is opened: the `<scenegrade-player>` bundle drops from ~200 KB to ~100 KB gzipped for EXR and image use.
- d70cece: A wheel or curve drag is one undo step however slow it is (`player.beginGradeEdit()` on pointer down … `commitGradeEdit()` on pointer up); before, pauses longer than 800 ms split it.
- @scenegrade/exr-wasm@0.2.0
