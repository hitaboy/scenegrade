import { Player, } from '@scenegrade/core';
/**
 * Bridges the headless Player to Svelte 5 runes. Components read `ctl.state` / `ctl.settings`
 * reactively and call `ctl.player.*` or `ctl.update()` to change things.
 */
export class PlayerController {
    player;
    state = $state(null);
    settings = $state(null);
    probe = $state(null);
    probePinned = $state([]);
    /** UI-only state shared between components. */
    ui = $state({
        tool: 'none',
        panelOpen: true,
        panelTab: 'scopes',
        guides: { safeAreas: false, thirds: false, center: false, mask: 0 },
        probeRadius: 0,
        help: false,
        clean: false,
        scopes: { histogram: true, waveform: true, vectorscope: true, parade: false },
        webgpuError: '',
    });
    unsub;
    constructor(opts = {}, existing) {
        this.player = existing ?? new Player(opts);
        this.settings = structuredClone(this.player.settings);
        this.unsub = this.player.subscribe((s) => {
            this.state = s;
            this.settings = structuredClone(this.player.settings);
        });
        this.player.ready().catch((e) => (this.ui.webgpuError = String(e?.message ?? e)));
    }
    update(patch) {
        this.player.update(patch);
    }
    load(input, opts) {
        return this.player.load(input, opts);
    }
    dispose() {
        this.unsub();
        this.player.dispose();
    }
}
