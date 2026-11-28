<script lang="ts">
  import { framesToTimecode, timecodeToFrames } from '@scenegrade/core';
  import type { PlayerController } from '../controller.svelte.js';
  import IconButton from './IconButton.svelte';
  import Timeline from './Timeline.svelte';

  let {
    ctl,
    compact = false,
    onfullscreen,
  }: { ctl: PlayerController; compact?: boolean; onfullscreen?: () => void } = $props();

  const m = $derived(ctl.state.media);
  const fps = $derived(m?.fps ?? 24);
  const frameNo = $derived((m?.firstFrame ?? 0) + ctl.state.frame);
  const tc = $derived(framesToTimecode((m?.startTimecodeFrames ?? 0) + ctl.state.frame, fps));
  let showTc = $state(true);
  let editing = $state(false);
  const SPEEDS = [-4, -2, -1, -0.5, 0.25, 0.5, 1, 2, 4];
  const loopIcon = $derived({ loop: 'loop', once: 'once', pingpong: 'pingpong' }[ctl.state.loop]);
  const nextLoop = { loop: 'pingpong', pingpong: 'once', once: 'loop' } as const;

  function jump(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value;
    const f = showTc ? timecodeToFrames(v, fps) : parseInt(v, 10);
    if (f != null && !Number.isNaN(f)) {
      ctl.player.seek(showTc ? f - (m?.startTimecodeFrames ?? 0) : f - (m?.firstFrame ?? 0));
    }
    editing = false;
  }
</script>

<div class="tr" class:compact>
  <div class="btns">
    {#if !compact}
      <IconButton
        icon="to-start"
        label="Go to in point"
        shortcut="Home"
        onclick={() => ctl.player.seek(ctl.state.inPoint)}
      />
      <IconButton
        icon="step-back"
        label="Previous frame"
        shortcut="←"
        onclick={() => ctl.player.step(-1)}
      />
    {/if}
    <IconButton
      icon={ctl.state.playing ? 'pause' : 'play'}
      label={ctl.state.playing ? 'Pause' : 'Play'}
      shortcut="Space"
      onclick={() => ctl.player.toggle()}
      disabled={!m || m.frameCount <= 1}
    />
    {#if !compact}
      <IconButton
        icon="step-fwd"
        label="Next frame"
        shortcut="→"
        onclick={() => ctl.player.step(1)}
      />
      <IconButton
        icon="to-end"
        label="Go to out point"
        shortcut="End"
        onclick={() => ctl.player.seek(ctl.state.outPoint)}
      />
    {/if}
  </div>

  <Timeline {ctl} />

  <div class="readout">
    {#if editing}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="tc"
        value={showTc ? tc : String(frameNo)}
        autofocus
        onblur={jump}
        onkeydown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') jump(e);
          if (e.key === 'Escape') editing = false;
        }}
        aria-label="Go to timecode or frame"
      />
    {:else}
      <button
        type="button"
        class="tc"
        title="Click to type a frame / timecode; right-click to toggle"
        onclick={() => (editing = true)}
        oncontextmenu={(e) => {
          e.preventDefault();
          showTc = !showTc;
        }}
      >
        {showTc ? tc : frameNo}
      </button>
    {/if}
    {#if !compact}
      <span class="sub" title="Frame number / last frame">
        {frameNo} / {(m?.firstFrame ?? 0) + (m?.frameCount ?? 1) - 1}
      </span>
    {/if}
  </div>

  {#if !compact}
    <div class="btns">
      <IconButton
        icon="in"
        label="Set in point"
        shortcut="I"
        onclick={() => ctl.player.setInOut(ctl.state.frame, ctl.state.outPoint)}
      />
      <IconButton
        icon="out"
        label="Set out point"
        shortcut="O"
        onclick={() => ctl.player.setInOut(ctl.state.inPoint, ctl.state.frame)}
      />
      <IconButton
        icon={loopIcon}
        label="Loop mode: {ctl.state.loop}"
        onclick={() => ctl.player.setLoop(nextLoop[ctl.state.loop])}
      />
      <label class="speed" title="Playback speed (J / K / L)">
        <select
          value={String(ctl.state.speed)}
          onchange={(e) =>
            ctl.player.setSpeed(parseFloat((e.currentTarget as HTMLSelectElement).value))}
          aria-label="Playback speed"
        >
          {#each SPEEDS as s (s)}<option value={String(s)}>{s}×</option>{/each}
        </select>
      </label>
      <button
        type="button"
        class="rt"
        class:on={!ctl.state.realtime}
        title="Real time drops frames to keep sync; 'All frames' never skips"
        onclick={() => ctl.player.setRealtime(!ctl.state.realtime)}
      >
        {ctl.state.realtime ? 'RT' : 'ALL'}
      </button>
      {#if m?.hasAudio}
        <IconButton
          icon={ctl.state.muted ? 'mute' : 'volume'}
          label={ctl.state.muted ? 'Unmute' : 'Mute'}
          shortcut="M"
          onclick={() => ctl.player.setMuted(!ctl.state.muted)}
        />
      {/if}
    </div>
    <div class="stats" title="Playback fps · decode time · GPU time · dropped frames · cache">
      <span>{ctl.state.playing ? ctl.state.stats.fps.toFixed(1) : '—'} fps</span>
      <span>{ctl.state.stats.decodeMs.toFixed(0)} ms</span>
      {#if ctl.state.stats.gpuMs > 0}<span>GPU {ctl.state.stats.gpuMs.toFixed(1)} ms</span>{/if}
      {#if ctl.state.stats.dropped > 0}<span class="warn">{ctl.state.stats.dropped} drop</span>{/if}
      <span>{(ctl.state.stats.cacheBytes / 1048576).toFixed(0)} MB</span>
    </div>
  {/if}
  {#if onfullscreen}
    <IconButton icon="fullscreen" label="Fullscreen" shortcut="F" onclick={onfullscreen} />
  {/if}
</div>

<style>
  .tr {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 44px;
    padding: 0 8px;
    border-top: 1px solid var(--sg-border);
    background: var(--sg-surface-1);
  }
  .btns {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .readout {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    min-width: 96px;
  }
  .tc {
    width: 104px;
    height: 20px;
    padding: 0 4px;
    border: 1px solid transparent;
    border-radius: var(--sg-radius-sm);
    background: none;
    color: var(--sg-text);
    font: 500 13px var(--sg-font-mono);
    text-align: right;
    cursor: text;
  }
  input.tc {
    border-color: var(--sg-border-strong);
    background: var(--sg-surface-2);
  }
  .sub {
    color: var(--sg-text-faint);
    font: var(--sg-text-xs) var(--sg-font-mono);
  }
  .speed select {
    height: 24px;
    padding: 0 4px;
    border: 1px solid var(--sg-border);
    border-radius: var(--sg-radius-sm);
    background: var(--sg-surface-2);
    color: var(--sg-text-muted);
    font: var(--sg-text-sm) var(--sg-font-mono);
  }
  .rt {
    height: 24px;
    min-width: 34px;
    border: 1px solid var(--sg-border);
    border-radius: var(--sg-radius-sm);
    background: none;
    color: var(--sg-text-muted);
    font: 600 var(--sg-text-xs) var(--sg-font-mono);
    cursor: pointer;
  }
  .rt.on {
    color: var(--sg-accent);
    border-color: var(--sg-accent);
  }
  .stats {
    /* Two columns so fps · decode · GPU · cache fit in the bar's height. */
    display: grid;
    grid-template-columns: auto auto;
    column-gap: 8px;
    min-width: 64px;
    color: var(--sg-text-faint);
    font: var(--sg-text-xs) var(--sg-font-mono);
    line-height: 1.25;
    text-align: right;
  }
  .warn {
    color: var(--sg-warn);
  }
  .compact {
    height: 40px;
    gap: 8px;
  }
  @media (max-width: 720px) {
    .stats,
    .sub {
      display: none;
    }
  }
</style>
