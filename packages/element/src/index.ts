/**
 * `<scenelinear-player>` — drop-in Web Component.
 *
 *   <script type="module" src="https://cdn.jsdelivr.net/npm/@scenelinear/element/dist/scenelinear-player.js"></script>
 *   <scenelinear-player src="shot.mov" input-space="arri-logc4" view="srgb-aces2-sdr709"></scenelinear-player>
 */
import './Element.svelte';

export type { DisplaySettings, MediaInput, MediaInfo, PlayerState } from '@scenelinear/core';
