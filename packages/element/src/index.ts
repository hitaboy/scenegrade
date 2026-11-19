/**
 * `<scenegrade-player>` — drop-in Web Component.
 *
 *   <script type="module" src="https://cdn.jsdelivr.net/npm/@scenegrade/element/dist/scenegrade-player.js"></script>
 *   <scenegrade-player src="shot.mov" input-space="arri-logc4" view="srgb-aces2-sdr709"></scenegrade-player>
 */
import './Element.svelte';

export type { DisplaySettings, MediaInput, MediaInfo, PlayerState } from '@scenegrade/core';
