import { Player, type PlayerOptions, type PlayerState, type DisplaySettings, type ProbeResult, type MediaInput, type OpenOptions } from '@scenelinear/core';
/**
 * Bridges the headless Player to Svelte 5 runes. Components read `ctl.state` / `ctl.settings`
 * reactively and call `ctl.player.*` or `ctl.update()` to change things.
 */
export declare class PlayerController {
    readonly player: Player;
    state: PlayerState;
    settings: DisplaySettings;
    probe: ProbeResult | null;
    probePinned: ProbeResult[];
    /** UI-only state shared between components. */
    ui: {
        tool: "none" | "probe";
        panelOpen: boolean;
        panelTab: "scopes" | "color" | "info";
        guides: {
            safeAreas: boolean;
            thirds: boolean;
            center: boolean;
            mask: number;
        };
        probeRadius: number;
        help: boolean;
        clean: boolean;
        scopes: {
            histogram: boolean;
            waveform: boolean;
            vectorscope: boolean;
            parade: boolean;
        };
        webgpuError: string;
    };
    private unsub;
    constructor(opts?: PlayerOptions, existing?: Player);
    update(patch: Partial<DisplaySettings>): void;
    load(input: MediaInput, opts?: OpenOptions): Promise<import("@scenelinear/core").MediaInfo>;
    dispose(): void;
}
