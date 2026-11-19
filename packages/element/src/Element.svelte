<svelte:options
  customElement={{
    tag: 'scenelinear-player',
    shadow: 'open',
    props: {
      src: { type: 'String', reflect: false },
      first: { type: 'Number' },
      last: { type: 'Number' },
      fps: { type: 'Number' },
      layout: { type: 'String' },
      inputSpace: { type: 'String', attribute: 'input-space' },
      view: { type: 'String' },
      exposure: { type: 'Number' },
      autoplay: { type: 'Boolean' },
      loop: { type: 'String' },
      muted: { type: 'Boolean' },
      panel: { type: 'String' },
      drop: { type: 'String' },
      tools: { type: 'String' },
      lutBase: { type: 'String', attribute: 'lut-base' },
      cacheMb: { type: 'Number', attribute: 'cache-mb' },
    },
  }}
/>

<script lang="ts">
  import { untrack } from 'svelte';
  import { ScenePlayer, type PlayerController } from '@scenelinear/svelte';
  import type { MediaInput, DisplaySettings, LoopMode, SetGradeOptions } from '@scenelinear/core';

  let {
    src = '',
    first = undefined,
    last = undefined,
    fps = undefined,
    layout = 'full',
    inputSpace = '',
    view = '',
    exposure = undefined,
    autoplay = false,
    loop = 'loop',
    muted = false,
    panel = 'true',
    drop = 'true',
    tools = '',
    lutBase = '',
    cacheMb = undefined,
  }: {
    src?: string;
    first?: number;
    last?: number;
    fps?: number;
    layout?: string;
    inputSpace?: string;
    view?: string;
    exposure?: number;
    autoplay?: boolean;
    loop?: string;
    muted?: boolean;
    panel?: string;
    drop?: string;
    tools?: string;
    lutBase?: string;
    cacheMb?: number;
  } = $props();

  // The custom element itself (shadow root host), resolved from the rendered root.
  let rootEl: HTMLDivElement;
  const hostEl = (): Element | null =>
    (rootEl?.getRootNode() as ShadowRoot | undefined)?.host ?? null;
  let ctl = $state<PlayerController>();

  // LUTs and WASM ship next to the bundle and are resolved relative to it; `lut-base` overrides.
  const options = untrack(() => ({ lutBaseUrl: lutBase || undefined, cacheMB: cacheMb }));

  const emit = (type: string, detail: unknown) =>
    hostEl()?.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));

  function input(): MediaInput | undefined {
    if (!src) return undefined;
    if (/#+|%0?\d*d|\$F\d?/.test(src) && first != null && last != null)
      return { url: src, first, last };
    return src;
  }

  async function load() {
    const c = ctl;
    const i = input();
    if (!c || !i) return;
    try {
      const info = await c.load(i, { fps });
      if (inputSpace) c.update({ inputSpace });
      if (view) c.update({ view });
      if (exposure != null) c.update({ exposure });
      c.player.setLoop(loop as LoopMode);
      c.player.setMuted(muted);
      emit('loaded', info);
      if (autoplay) c.player.play();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') emit('error', { message: (e as Error).message });
    }
  }

  let loadedKey = '';
  $effect(() => {
    const key = `${src}|${first}|${last}|${fps}`;
    if (ctl && key !== loadedKey) {
      loadedKey = key;
      untrack(() => void load());
    }
  });
  $effect(() => {
    const v = inputSpace;
    if (ctl && v) untrack(() => ctl!.update({ inputSpace: v }));
  });
  $effect(() => {
    const v = view;
    if (ctl && v) untrack(() => ctl!.update({ view: v }));
  });
  $effect(() => {
    const v = exposure;
    if (ctl && v != null) untrack(() => ctl!.update({ exposure: v }));
  });
  $effect(() => {
    const v = loop as LoopMode;
    if (ctl) untrack(() => ctl!.player.setLoop(v));
  });
  $effect(() => {
    const v = muted;
    if (ctl) untrack(() => ctl!.player.setMuted(v));
  });
  $effect(() => {
    // tools="falsecolor,zebra,clipping,peaking,probe,scopes"
    const c = ctl;
    const list = tools;
    if (!c || !list) return;
    untrack(() => applyTools(c, list));
  });
  function applyTools(c: PlayerController, list: string) {
    const t = new Set(list.split(/[\s,]+/));
    const patch: Partial<DisplaySettings> = {};
    if (t.has('falsecolor')) patch.falseColor = 'stops';
    if (t.has('zebra')) patch.zebra = { ...c.settings.zebra, high: true };
    if (t.has('clipping')) patch.clipping = { over: true, under: true, nan: true };
    if (t.has('peaking')) patch.peaking = { ...c.settings.peaking, enabled: true };
    c.update(patch);
    if (t.has('probe')) c.ui.tool = 'probe';
  }

  function ready(c: PlayerController) {
    ctl = c;
    let lastFrame = -1;
    c.player.subscribe((s, changed) => {
      if (changed.has('frame') && s.frame !== lastFrame) {
        lastFrame = s.frame;
        emit('frame', { frame: s.frame, frameNumber: s.frame + (s.media?.firstFrame ?? 0) });
      }
      if (changed.has('playing')) emit(s.playing ? 'play' : 'pause', null);
      if (changed.has('error') && s.error) emit('error', { message: s.error });
      if (changed.has('gradeRevision')) emit('gradechange', { grade: c.player.getGrade() });
    });
    emit('ready', null);
  }

  // ---- Public element API (element.play(), element.player...) ----------------------------
  export function play() {
    ctl?.player.play();
  }
  export function pause() {
    ctl?.player.pause();
  }
  export function seek(frame: number) {
    ctl?.player.seek(frame);
  }
  export function step(delta = 1) {
    ctl?.player.step(delta);
  }
  export function setSettings(patch: Partial<DisplaySettings>) {
    ctl?.update(patch);
  }
  export function open(media: MediaInput) {
    return ctl?.load(media);
  }
  export function compare(media: MediaInput | null) {
    return ctl?.player.loadCompare(media);
  }
  /** Current grade as JSON (see docs/grading.md). */
  export function getGrade() {
    return ctl?.player.getGrade();
  }
  /** Replaces the grade; any JSON is validated and completed with defaults. */
  export function setGrade(grade: unknown, opts?: SetGradeOptions) {
    ctl?.player.setGrade(grade, opts);
  }
  export function undo() {
    return ctl?.player.undo() ?? false;
  }
  export function redo() {
    return ctl?.player.redo() ?? false;
  }
  export function getPlayer() {
    return ctl?.player;
  }
</script>

<div class="host-root" bind:this={rootEl}>
  <ScenePlayer
    layout={layout === 'compact' ? 'compact' : layout === 'grade' ? 'grade' : 'full'}
    panel={panel !== 'false'}
    allowDrop={drop !== 'false'}
    {options}
    onready={ready}
  />
</div>

<style>
  :host {
    display: block;
    position: relative;
    width: 100%;
    height: 480px;
    contain: content;
  }
  .host-root {
    width: 100%;
    height: 100%;
  }
</style>
