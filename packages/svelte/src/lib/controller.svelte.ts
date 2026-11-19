import {
  Player,
  type PlayerOptions,
  type PlayerState,
  type DisplaySettings,
  type ProbeResult,
  type MediaInput,
  type OpenOptions,
  type Grade,
  type GradeNode,
  type GradeNodePatch,
} from '@scenelinear/core';

export interface Still {
  id: string;
  name: string;
  /** Small JPEG data URL. */
  thumb: string;
  grade: Grade;
  frame: number;
}

/**
 * Bridges the headless Player to Svelte 5 runes. Components read `ctl.state` / `ctl.settings`
 * reactively and call `ctl.player.*` or `ctl.update()` to change things.
 */
export class PlayerController {
  readonly player: Player;
  state = $state<PlayerState>(null as unknown as PlayerState);
  settings = $state<DisplaySettings>(null as unknown as DisplaySettings);
  /** Current grade (replaced on every change; edit through `player.setGrade/updateGradeNode`). */
  grade = $state<Grade>(null as unknown as Grade);
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
    /** Grade palette (bottom panel). */
    gradeOpen: false,
    gradeTab: 'primaries' as 'primaries' | 'log' | 'curves' | 'hsl' | 'mixer',
    /** Selected grade node id ('' = first node). */
    gradeNode: '',
  });
  stills = $state<Still[]>([]);
  private unsub: () => void;

  constructor(opts: PlayerOptions = {}, existing?: Player) {
    this.player = existing ?? new Player(opts);
    this.settings = structuredClone(this.player.settings);
    this.grade = this.player.getGrade();
    this.unsub = this.player.subscribe((s, changed) => {
      this.state = s;
      this.settings = structuredClone(this.player.settings);
      if (changed.has('gradeRevision')) this.grade = this.player.getGrade();
    });
    this.player.ready().catch((e) => (this.ui.webgpuError = String(e?.message ?? e)));
  }

  update(patch: Partial<DisplaySettings>): void {
    this.player.update($state.snapshot(patch) as Partial<DisplaySettings>);
  }

  /** The node the grade palette edits (falls back to the first one). */
  get node(): GradeNode | undefined {
    const nodes = this.grade?.nodes ?? [];
    return nodes.find((n) => n.id === this.ui.gradeNode) ?? nodes[0];
  }

  /**
   * Edits the selected node. Continuous controls pass a `key` so a drag is one undo step; call
   * `commitEdit()` when the gesture ends.
   */
  editNode(patch: GradeNodePatch, key?: string): void {
    let n = this.node;
    if (!n) {
      this.player.setGrade({ ...this.player.getGrade(), nodes: [{}] }, { history: false });
      n = this.node;
    }
    this.player.updateGradeNode(n!.id, $state.snapshot(patch) as GradeNodePatch, {
      history: key ?? true,
    });
  }

  commitEdit(): void {
    this.player.commitGradeEdit();
  }

  async grabStill(): Promise<Still | null> {
    const blob = await this.player.snapshot().catch(() => null);
    if (!blob) return null;
    const bmp = await createImageBitmap(blob);
    const w = 192;
    const h = Math.max(1, Math.round((bmp.height / bmp.width) * w));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    cv.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const frame = this.state.frame + (this.state.media?.firstFrame ?? 0);
    const still: Still = {
      id: `s${Date.now().toString(36)}`,
      name: `${this.state.media?.name ?? 'Still'} · ${frame}`,
      thumb: cv.toDataURL('image/jpeg', 0.85),
      grade: this.player.getGrade(),
      frame,
    };
    this.stills = [...this.stills, still];
    return still;
  }

  load(input: MediaInput, opts?: OpenOptions) {
    return this.player.load(input, opts);
  }

  dispose(): void {
    this.unsub();
    this.player.dispose();
  }
}
