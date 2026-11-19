# @scenegrade/element

`<scenegrade-player>`, a drop-in Web Component for ACES-managed playback of EXR, ProRes and video,
with scopes, false colour, zebra and A/B compare.

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@scenegrade/element/dist/scenegrade-player.js"></script>
<scenegrade-player src="shot.mov" input-space="acescct" view="srgb-aces2-sdr709"></scenegrade-player>
```

Attributes, methods, events and theming: see the [integration guide](../../docs/integration.md).
The bundle loads its LUTs and WASM decoders lazily from the files next to it, so serve the whole
`dist/` folder. A runnable page is in [`example/index.html`](example/index.html). Apache-2.0.
