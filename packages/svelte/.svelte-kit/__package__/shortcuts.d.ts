import type { PlayerController } from './controller.svelte.js';
export interface Shortcut {
    keys: string;
    label: string;
    group: 'Playback' | 'View' | 'Analysis' | 'Panels';
}
export declare const SHORTCUTS: Shortcut[];
/** Handles a keydown for the player. Returns true when handled. */
export declare function handleKey(ctl: PlayerController, e: KeyboardEvent, extra: {
    fullscreen?: () => void;
}): boolean;
