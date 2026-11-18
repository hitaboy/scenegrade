# @scenelinear/core

Headless engine of [scenelinear](../../README.md): WebGPU renderer, ACES colour pipeline, scopes,
overlays, frame cache and frame-accurate playback for EXR, ProRes and WebCodecs video. No UI, no
framework.

```ts
import { Player, color } from '@scenelinear/core';

const player = new Player();
await player.attach(canvas);
player.resize(canvas.clientWidth, canvas.clientHeight);
await player.load({ url: '/plates/a.####.exr', first: 1001, last: 1100 });
player.update({ inputSpace: 'acescg', view: 'srgb-aces2-sdr709', exposure: 0.5, falseColor: 'stops' });
player.attachScope(scopeCanvas, 'parade');
player.play();
```

- `Player`: `load`, `loadCompare`, `play/pause/seek/step`, `setInOut`, `setLoop`, `setSpeed`,
  `update(settings)`, `zoomTo/panBy/fit`, `probe`, `snapshot` and `subscribe(state => …)`.
- `color`: `INPUT_SPACES`, `VIEWS`, `inputToACEScg`, `loadViewLut`, `applyViewCPU`,
  `parseCubeLut`, `applyCDL`, false-colour presets, and the WGSL sources.
- `openMedia`, `detectSequences`, `expandPattern`: media helpers.

Requires WebGPU. See the [integration guide](../../docs/integration.md) and
[architecture](../../docs/architecture.md). Apache-2.0.
