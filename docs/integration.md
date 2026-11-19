# Integration guide

## 1. Web Component (any site, any framework)

```html
<script
  type="module"
  src="https://cdn.jsdelivr.net/npm/@scenegrade/element/dist/scenegrade-player.js"
></script>

<scenegrade-player
  src="https://example.com/shot_010.mov"
  input-space="acescct"
  view="srgb-aces2-sdr709"
  layout="full"
  tools="zebra,falsecolor"
  style="height: 600px"
></scenegrade-player>
```

Or with npm: `npm i @scenegrade/element`, then `import '@scenegrade/element'`. The LUT and WASM
files ship next to the bundle and are fetched on demand, so serve `dist/` as is.

### Attributes

| Attribute           | Values                         |                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src`               | URL                            | Video, image, EXR, or a frame pattern (`shot.####.exr`, `%04d`, `$F4`)                                                                                                                                                                      |
| `first`, `last`     | integers                       | Frame range for a pattern `src`                                                                                                                                                                                                             |
| `fps`               | number                         | Override the frame rate (sequences default to the EXR `framesPerSecond` or 24)                                                                                                                                                              |
| `input-space`       | id                             | e.g. `acescg`, `aces2065-1`, `acescct`, `arri-logc4`, `sony-slog3-sgamut3cine`, `rec709`, `srgb`. The default is auto-detected from metadata                                                                                                |
| `view`              | id                             | `srgb-aces2-sdr709`, `rec1886-aces2-sdr709`, `displayp3-aces2-sdrp3`, `pq-aces2-hdr1000-p3`, `pq-aces2-hdr1000-rec2020`, `hlg-aces2-hdr1000-p3`, `displayp3hdr-aces2-hdr1000-p3`, `srgb-aces1-sdrvideo`, `raw`, `log-acescct`, `srgb-clamp` |
| `exposure`          | stops                          |                                                                                                                                                                                                                                             |
| `layout`            | `full` \| `compact` \| `grade` | `compact` shows only the transport plus a settings popover; `grade` opens the grade palette (`E` toggles it in `full`)                                                                                                                      |
| `panel`             | `true` \| `false`              | Show the scopes/colour/info side panel                                                                                                                                                                                                      |
| `drop`              | `true` \| `false`              | Allow drag & drop and the open dialog                                                                                                                                                                                                       |
| `autoplay`, `muted` | boolean                        |                                                                                                                                                                                                                                             |
| `loop`              | `loop` \| `once` \| `pingpong` |                                                                                                                                                                                                                                             |
| `tools`             | list                           | `falsecolor`, `zebra`, `clipping`, `peaking`, `probe` enabled on load                                                                                                                                                                       |
| `lut-base`          | URL                            | Folder with the view LUTs, if you host them elsewhere                                                                                                                                                                                       |
| `cache-mb`          | number                         | CPU frame cache budget                                                                                                                                                                                                                      |

### Methods and events

```js
const el = document.querySelector('scenegrade-player');
el.play(); el.pause(); el.seek(42); el.step(-1);
el.setSettings({ exposure: 1, falseColor: 'stops', zebra: { high: true } });
el.open({ url: '/plates/a.####.exr', first: 1001, last: 1100 });
el.compare('/renders/v002.mov');          // A/B
const player = el.getPlayer();            // full core Player API

el.addEventListener('loaded', (e) => console.log(e.detail));   // MediaInfo
el.addEventListener('frame', (e) => console.log(e.detail.frameNumber));
el.addEventListener('play', ...); el.addEventListener('pause', ...);
el.addEventListener('error', (e) => console.error(e.detail.message));

// Grading (see grading.md): persist the grade in your backend
el.setGrade(savedJson);
el.addEventListener('gradechange', (e) => save(e.detail.grade));
el.undo(); el.redo();
```

### Theming

The UI uses neutral greys on purpose. Accent colour, fonts and sizes are CSS custom properties:

```css
scenegrade-player {
  --sg-accent: #7fb0ff;
  --sg-font: 'Inter', sans-serif;
  --sg-panel-w: 340px;
}
```

See [`packages/svelte/src/lib/tokens.css`](../packages/svelte/src/lib/tokens.css) for the full list.

## 2. Svelte 5

```svelte
<script>
  import { ScenePlayer } from '@scenegrade/svelte';
  let ctl = $state();
</script>

<div style="height: 80vh">
  <ScenePlayer src="/shot.mov" bind:controller={ctl} />
</div>
<button onclick={() => ctl.update({ view: 'pq-aces2-hdr1000-p3' })}>HDR</button>
```

You can also build your own layout from the parts: `Viewer`, `Transport`, `Timeline`, `Scope`,
`ScopesPanel`, `ColorPanel`, `InfoPanel`, `GradePanel`, `ColorWheel` and `CurveEditor`, all
sharing one `PlayerController`.

## 3. Headless (React, Vue, plain JS…)

```ts
import { Player } from '@scenegrade/core';

const player = new Player();
await player.attach(canvas); // any number of canvases
new ResizeObserver(([e]) => player.resize(e.contentRect.width, e.contentRect.height)).observe(
  canvas,
);

await player.load(fileOrUrl); // File, File[], URL, { url, first, last }, { directory }
player.update({ inputSpace: 'arri-logc4', view: 'srgb-aces2-sdr709', exposure: 0.5 });
player.attachScope(waveCanvas, 'parade');
player.subscribe((state) => render(state)); // frame, playing, media, stats, cache…
const px = await player.probe(x, y); // { scene, display, nits, stops, source }
```

The colour module can be used without a player:

```ts
import { color } from '@scenegrade/core';
const lut = await color.loadViewLut('srgb-aces2-sdr709');
color.applyViewCPU(lut, color.inputToACEScg('arri-logc4', [0.4, 0.4, 0.4]));
```

## Hosting notes

- **No special headers are needed.** With COOP/COEP (cross-origin isolation) the ProRes decoder can additionally use shared-memory threads; without them it uses a worker pool.
- **CORS:** media on another origin must send `Access-Control-Allow-Origin`. Range requests are
  used for video, so allow the `Range` header.
- **Content Security Policy:** allow `'wasm-unsafe-eval'` in `script-src` and workers from the bundle's origin
  (`worker-src 'self'`; add `blob:` if your CSP blocks the ProRes decoder's workers).
