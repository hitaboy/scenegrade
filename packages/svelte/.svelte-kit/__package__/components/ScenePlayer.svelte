<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { MediaInput, PlayerOptions, Player } from '@scenelinear/core';
  import { PlayerController } from '../controller.svelte.js';
  import { handleKey } from '../shortcuts.js';
  import Viewer from './Viewer.svelte';
  import TopBar from './TopBar.svelte';
  import ToolRail from './ToolRail.svelte';
  import Transport from './Transport.svelte';
  import ScopesPanel from './ScopesPanel.svelte';
  import ColorPanel from './ColorPanel.svelte';
  import InfoPanel from './InfoPanel.svelte';
  import Help from './Help.svelte';
  import IconButton from './IconButton.svelte';
  import Icon from './Icon.svelte';
  import tokens from '../tokens.css?inline';

  let {
    src = undefined,
    layout = 'full',
    options = {},
    controller = $bindable(),
    player = undefined,
    allowDrop = true,
    panel = true,
    onready,
  }: {
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
  } = $props();

  // Options/player are read once at construction (changing them later has no effect by design).
  const ctl = untrack(() => new PlayerController(options, player));
  controller = ctl;
  ctl.ui.panelOpen = untrack(() => panel && layout === 'full');

  let root: HTMLDivElement;
  let fileInput: HTMLInputElement;
  let compareInput: HTMLInputElement;
  let dragOver = $state(false);
  let settingsOpen = $state(false);
  let lastSrc: unknown = undefined;

  $effect(() => {
    if (src !== undefined && src !== lastSrc) {
      lastSrc = src;
      ctl.load(src).catch(() => undefined);
    }
  });

  onMount(() => {
    // Design tokens: inject once per root (document head, or the shadow root of the web component).
    const rootNode = root.getRootNode() as Document | ShadowRoot;
    const host = rootNode instanceof ShadowRoot ? rootNode : document.head;
    if (!host.querySelector('style[data-scenelinear-tokens]')) {
      const st = document.createElement('style');
      st.dataset.scenelinearTokens = '';
      st.textContent = tokens;
      host.prepend(st);
    }
    onready?.(ctl);
    return () => ctl.dispose();
  });

  function keydown(e: KeyboardEvent) {
    if (handleKey(ctl, e, { fullscreen })) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function fullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.requestFullscreen?.();
  }

  async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
    const out: File[] = [];
    const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
    const walk = async (e: FileSystemEntry): Promise<void> => {
      if (e.isFile) out.push(await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)));
      else if (e.isDirectory) {
        const reader = (e as FileSystemDirectoryEntry).createReader();
        let batch: FileSystemEntry[];
        do {
          batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
          for (const c of batch) await walk(c);
        } while (batch.length);
      }
    };
    if (entries.length) for (const e of entries) await walk(e);
    else out.push(...dt.files);
    return out;
  }

  async function drop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    if (!allowDrop || !e.dataTransfer) return;
    const files = await filesFromDrop(e.dataTransfer);
    if (!files.length) return;
    if (e.altKey && ctl.state.media) await ctl.player.loadCompare(files.length === 1 ? files[0] : files);
    else await ctl.load(files.length === 1 ? files[0] : files).catch(() => undefined);
  }

  function pick(e: Event, compare = false) {
    const files = (e.currentTarget as HTMLInputElement).files;
    if (!files?.length) return;
    const arg = files.length === 1 ? files[0] : [...files];
    if (compare) void ctl.player.loadCompare(arg);
    else void ctl.load(arg).catch(() => undefined);
    (e.currentTarget as HTMLInputElement).value = '';
  }

  function compareClick() {
    if (ctl.state.mediaB) {
      void ctl.player.loadCompare(null);
      ctl.update({ compare: { ...ctl.settings.compare, mode: 'off' } });
    } else compareInput.click();
  }
  const ACCEPT = '.exr,.mov,.mp4,.m4v,.mkv,.webm,.png,.jpg,.jpeg,.webp,.avif';
  const compareModes = ['wipe', 'side-by-side', 'difference', 'blend'] as const;
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="sl-player"
  class:compact={layout === 'compact'}
  class:clean={ctl.ui.clean}
  class:drag={dragOver}
  bind:this={root}
  tabindex="0"
  role="application"
  aria-label="scenelinear media player"
  onkeydown={keydown}
  ondragover={(e) => {
    if (!allowDrop) return;
    e.preventDefault();
    dragOver = true;
  }}
  ondragleave={(e) => {
    if (e.target === root) dragOver = false;
  }}
  ondrop={drop}
>
  <input bind:this={fileInput} type="file" multiple accept={ACCEPT} hidden onchange={(e) => pick(e)} />
  <input bind:this={compareInput} type="file" multiple accept={ACCEPT} hidden onchange={(e) => pick(e, true)} />

  {#if layout === 'full' && !ctl.ui.clean}
    <TopBar {ctl} onopen={allowDrop ? () => fileInput.click() : undefined} />
  {/if}

  <div class="main">
    {#if layout === 'full' && !ctl.ui.clean}
      <ToolRail {ctl} oncompare={compareClick} />
    {/if}

    <div class="stage">
      {#if ctl.ui.webgpuError}
        <div class="empty">
          <p class="title">WebGPU is not available</p>
          <p>{ctl.ui.webgpuError}</p>
          <p class="dim">Use a recent Chrome, Edge or Safari 26+, or Firefox with WebGPU enabled.</p>
        </div>
      {:else}
        <Viewer {ctl} />
        {#if !ctl.state.media && !ctl.state.loading}
          <div class="empty">
            <Icon name="open" size={28} />
            <p class="title">Drop EXR, ProRes or video here</p>
            <p class="dim">Drop a folder or several frames for a sequence · Alt+drop for A/B compare</p>
            {#if allowDrop}<button type="button" class="open" onclick={() => fileInput.click()}>Open files…</button>{/if}
          </div>
        {/if}
      {/if}
      {#if ctl.state.error}
        <div class="error" role="alert">
          {ctl.state.error}
          <button type="button" aria-label="Dismiss" onclick={() => (ctl.state.error = null)}>×</button>
        </div>
      {/if}
      {#if ctl.state.mediaB && layout === 'full' && !ctl.ui.clean}
        <div class="cmp" role="group" aria-label="Compare mode">
          <span class="ab">A: {ctl.state.media?.name}  ·  B: {ctl.state.mediaB.name}</span>
          {#each compareModes as m (m)}
            <button type="button" class:on={ctl.settings.compare.mode === m} onclick={() => { ctl.update({ compare: { ...ctl.settings.compare, mode: m } }); ctl.player.fit(); }}>{m}</button>
          {/each}
        </div>
      {/if}
      {#if layout === 'compact'}
        <div class="quick">
          <IconButton icon="sliders" label="Viewer settings" active={settingsOpen} onclick={() => (settingsOpen = !settingsOpen)} />
        </div>
        {#if settingsOpen}
          <div class="popover">
            <TopBar {ctl} />
            <div class="pop-tools"><ToolRail {ctl} oncompare={compareClick} /></div>
            <div class="pop-scopes"><ScopesPanel {ctl} /></div>
          </div>
        {/if}
      {/if}
      {#if ctl.ui.help}<Help onclose={() => (ctl.ui.help = false)} />{/if}
      {#if dragOver}<div class="dropzone">Drop to open{ctl.state.media ? ' · hold Alt to compare' : ''}</div>{/if}
    </div>

    {#if layout === 'full' && ctl.ui.panelOpen && !ctl.ui.clean}
      <aside class="panel" aria-label="Analysis panel">
        <div class="tabs" role="tablist">
          {#each [['scopes', 'Scopes', 'scopes'], ['color', 'Colour', 'sliders'], ['info', 'Info', 'info']] as [id, label, icon] (id)}
            <button type="button" role="tab" aria-selected={ctl.ui.panelTab === id} class:on={ctl.ui.panelTab === id} onclick={() => (ctl.ui.panelTab = id as 'scopes')}>
              <Icon name={icon} size={14} />{label}
            </button>
          {/each}
          <span class="grow"></span>
          <IconButton icon="close" label="Hide panel" shortcut="S" size={14} onclick={() => (ctl.ui.panelOpen = false)} />
        </div>
        <div class="tabbody">
          {#if ctl.ui.panelTab === 'scopes'}<ScopesPanel {ctl} />{/if}
          {#if ctl.ui.panelTab === 'color'}<ColorPanel {ctl} />{/if}
          {#if ctl.ui.panelTab === 'info'}<InfoPanel {ctl} />{/if}
        </div>
      </aside>
    {:else if layout === 'full' && !ctl.ui.clean}
      <button type="button" class="panel-open" aria-label="Show analysis panel (S)" title="Show panel (S)" onclick={() => (ctl.ui.panelOpen = true)}>
        <Icon name="panel" />
      </button>
    {/if}
  </div>

  {#if !ctl.ui.clean}
    <Transport {ctl} compact={layout === 'compact'} onfullscreen={fullscreen} />
  {/if}
</div>

<style>
  .sl-player {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 240px;
    overflow: hidden;
    background: var(--sl-bg);
    color: var(--sl-text);
    font-family: var(--sl-font);
    font-size: var(--sl-text-md);
    -webkit-font-smoothing: antialiased;
    outline: none;
    user-select: none;
  }
  .sl-player:focus-visible {
    box-shadow: inset 0 0 0 1px var(--sl-accent);
  }
  .main {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .stage {
    position: relative;
    display: flex;
    flex: 1;
    min-width: 0;
  }
  .panel {
    display: flex;
    flex-direction: column;
    width: var(--sl-panel-w);
    border-left: 1px solid var(--sl-border);
    background: var(--sl-surface-1);
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 34px;
    padding: 0 4px;
    border-bottom: 1px solid var(--sl-border);
  }
  .tabs button[role='tab'] {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--sl-radius-sm);
    background: none;
    color: var(--sl-text-muted);
    font: inherit;
    font-size: var(--sl-text-sm);
    cursor: pointer;
  }
  .tabs button.on {
    background: var(--sl-surface-3);
    color: var(--sl-text);
  }
  .tabs button:focus-visible {
    outline: none;
    box-shadow: var(--sl-focus);
  }
  .grow {
    flex: 1;
  }
  .tabbody {
    flex: 1;
    overflow-y: auto;
  }
  .panel-open {
    position: absolute;
    right: 6px;
    top: 6px;
    z-index: 2;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--sl-border);
    border-radius: var(--sl-radius);
    background: var(--sl-surface-1);
    color: var(--sl-text-muted);
    cursor: pointer;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--sl-text-muted);
    text-align: center;
    pointer-events: none;
  }
  .empty p {
    margin: 0;
  }
  .empty .title {
    color: var(--sl-text);
    font-size: var(--sl-text-lg);
  }
  .dim {
    color: var(--sl-text-faint);
    font-size: var(--sl-text-sm);
  }
  .open {
    margin-top: 8px;
    padding: 6px 14px;
    border: 1px solid var(--sl-border-strong);
    border-radius: var(--sl-radius);
    background: var(--sl-surface-2);
    color: var(--sl-text);
    font: inherit;
    cursor: pointer;
    pointer-events: auto;
  }
  .open:hover {
    background: var(--sl-surface-3);
  }
  .error {
    position: absolute;
    left: 50%;
    top: 10px;
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    gap: 10px;
    align-items: center;
    max-width: 80%;
    padding: 6px 10px;
    border: 1px solid var(--sl-danger);
    border-radius: var(--sl-radius);
    background: var(--sl-surface-1);
    color: var(--sl-text);
    font-size: var(--sl-text-sm);
  }
  .error button {
    border: 0;
    background: none;
    color: var(--sl-text-muted);
    font-size: 16px;
    cursor: pointer;
  }
  .cmp {
    position: absolute;
    left: 50%;
    bottom: 10px;
    transform: translateX(-50%);
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--sl-border);
    border-radius: var(--sl-radius);
    background: color-mix(in srgb, var(--sl-surface-1) 92%, transparent);
  }
  .cmp .ab {
    padding: 0 8px;
    color: var(--sl-text-faint);
    font-size: var(--sl-text-xs);
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cmp button {
    height: 22px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--sl-radius-sm);
    background: none;
    color: var(--sl-text-muted);
    font: inherit;
    font-size: var(--sl-text-xs);
    text-transform: capitalize;
    cursor: pointer;
  }
  .cmp button.on {
    background: var(--sl-surface-3);
    color: var(--sl-text);
  }
  .dropzone {
    position: absolute;
    inset: 8px;
    z-index: 8;
    display: grid;
    place-items: center;
    border: 2px dashed var(--sl-accent);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.45);
    color: var(--sl-text);
    font-size: var(--sl-text-lg);
    pointer-events: none;
  }
  .quick {
    position: absolute;
    right: 6px;
    top: 6px;
    z-index: 4;
    border-radius: var(--sl-radius);
    background: color-mix(in srgb, var(--sl-surface-1) 85%, transparent);
  }
  .popover {
    position: absolute;
    right: 6px;
    top: 40px;
    bottom: 6px;
    z-index: 6;
    display: flex;
    flex-direction: column;
    width: min(360px, calc(100% - 12px));
    overflow: auto;
    border: 1px solid var(--sl-border-strong);
    border-radius: var(--sl-radius);
    background: var(--sl-surface-1);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  }
  .pop-tools :global(.rail) {
    flex-direction: row;
    flex-wrap: wrap;
    width: auto;
    border-right: 0;
    border-bottom: 1px solid var(--sl-border);
  }
  .pop-tools :global(.rail .grow),
  .pop-tools :global(.rail .sep) {
    display: none;
  }
  @media (max-width: 760px) {
    .panel {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      z-index: 6;
      width: min(var(--sl-panel-w), 85%);
      box-shadow: -8px 0 30px rgba(0, 0, 0, 0.5);
    }
  }
</style>
