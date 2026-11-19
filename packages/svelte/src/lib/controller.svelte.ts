import {
  Player,
  type PlayerOptions,
  type PlayerState,
  type DisplaySettings,
  type ProbeResult,
  type MediaInput,
  type OpenOptions,
} from '@scenelinear/core';

/**
 * Bridges the headless Player to Svelte 5 runes. Components read `ctl.state` / `ctl.settings`
 * reactively and call `ctl.player.*` or `ctl.update()` to change things.
 */
export class PlayerController {
  readonly player: Player;
  state = $state<PlayerState>(null as unknown as PlayerState);
  settings = $state<DisplaySettings>(null as unknown as DisplaySettings);
  probe = $state<ProbeResult | null>(null);
  probePinned = $state<ProbeResult[]>([]);
  /** UI-only state shared between components. */
  ui = $state({
    tool: 'none' as 'none' | 'probe',
    panelOpen: true,
    panelTab: 'scopes' as 'scopes' | 'color' | 'info',
    guides: { safeAreas: false, thirds: false, center: false, mask: 0 as number },
    probeRadius: 0,
    help: false,
    clean: false,
    scopes: { histogram: true, waveform: true, vectorscope: true, parade: false },
    webgpuError: '' as string,
  });
  private unsub: () => void;

  constructor(opts: PlayerOptions = {}, existing?: Player) {
    this.player = existing ?? new Player(opts);
    this.settings = structuredClone(this.player.settings);
    this.unsub = this.player.subscribe((s) => {
      this.state = s;
      this.settings = structuredClone(this.player.settings);
    });
    this.player.ready().catch((e) => (this.ui.webgpuError = String(e?.message ?? e)));
  }

  update(patch: Partial<DisplaySettings>): void {
    this.player.update($state.snapshot(patch) as Partial<DisplaySettings>);
  }

  load(input: MediaInput, opts?: OpenOptions) {
    return this.player.load(input, opts);
  }

  dispose(): void {
    this.unsub();
    this.player.dispose();
  }
}
