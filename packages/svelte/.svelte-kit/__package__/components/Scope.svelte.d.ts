import type { ScopeKind } from '@scenelinear/core';
import type { PlayerController } from '../controller.svelte.js';
type $$ComponentProps = {
    ctl: PlayerController;
    kind: ScopeKind;
    height?: number;
    gain?: number;
    logScale?: boolean;
    channels?: {
        r: boolean;
        g: boolean;
        b: boolean;
        luma: boolean;
    };
};
declare const Scope: import("svelte").Component<$$ComponentProps, {}, "">;
type Scope = ReturnType<typeof Scope>;
export default Scope;
