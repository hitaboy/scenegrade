import type { MediaInput, PlayerOptions, Player } from '@scenegrade/core';
import { PlayerController } from '../controller.svelte.js';
type $$ComponentProps = {
    /** Anything `Player.load` accepts. */
    src?: MediaInput;
    layout?: 'full' | 'compact';
    options?: PlayerOptions;
    controller?: PlayerController;
    /** Use an existing headless Player instead of creating one. */
    player?: Player;
    allowDrop?: boolean;
    panel?: boolean;
    onready?: (ctl: PlayerController) => void;
};
declare const ScenePlayer: import("svelte").Component<$$ComponentProps, {}, "controller">;
type ScenePlayer = ReturnType<typeof ScenePlayer>;
export default ScenePlayer;
