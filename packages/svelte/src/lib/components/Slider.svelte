<script lang="ts">
  /**
   * Numeric control: drag the track, scroll, arrow keys (Shift = ×10), double-click to reset,
   * or click the value to type it.
   */
  let {
    value,
    min,
    max,
    step = 0.01,
    label,
    reset = 0,
    unit = '',
    digits = 2,
    onchange,
    width = '120px',
    bipolar = false,
  }: {
    value: number;
    min: number;
    max: number;
    step?: number;
    label: string;
    reset?: number;
    unit?: string;
    digits?: number;
    onchange: (v: number) => void;
    width?: string;
    bipolar?: boolean;
  } = $props();

  let editing = $state(false);
  let track: HTMLDivElement;
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const frac = $derived((Math.min(max, Math.max(min, value)) - min) / (max - min));
  const zero = $derived(bipolar ? (0 - min) / (max - min) : 0);

  function fromPointer(e: PointerEvent) {
    const r = track.getBoundingClientRect();
    onchange(clamp(min + ((e.clientX - r.left) / r.width) * (max - min)));
  }
  function down(e: PointerEvent) {
    track.setPointerCapture(e.pointerId);
    fromPointer(e);
  }
  function move(e: PointerEvent) {
    if (track.hasPointerCapture(e.pointerId)) fromPointer(e);
  }
  function key(e: KeyboardEvent) {
    const k = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') onchange(clamp(value + step * k));
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onchange(clamp(value - step * k));
    else if (e.key === 'Home') onchange(min);
    else if (e.key === 'End') onchange(max);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  function wheel(e: WheelEvent) {
    e.preventDefault();
    onchange(clamp(value - Math.sign(e.deltaY) * step * (e.shiftKey ? 10 : 1)));
  }
  function commit(e: Event) {
    const v = parseFloat((e.currentTarget as HTMLInputElement).value);
    if (!Number.isNaN(v)) onchange(clamp(v));
    editing = false;
  }
  const shown = $derived(`${bipolar && value > 0 ? '+' : ''}${value.toFixed(digits)}${unit}`);
</script>

<div class="sl" style:width>
  <span class="lbl">{label}</span>
  <div
    class="track"
    bind:this={track}
    role="slider"
    tabindex="0"
    aria-label={label}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={value}
    aria-valuetext={shown}
    onpointerdown={down}
    onpointermove={move}
    onkeydown={key}
    onwheel={wheel}
    ondblclick={() => onchange(reset)}
    title="Double-click to reset"
  >
    <div
      class="fill"
      style:left="{Math.min(zero, frac) * 100}%"
      style:width="{Math.abs(frac - zero) * 100}%"
    ></div>
    <div class="thumb" style:left="{frac * 100}%"></div>
  </div>
  {#if editing}
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="val"
      type="number"
      {min}
      {max}
      {step}
      value={value.toFixed(digits)}
      autofocus
      onblur={commit}
      onkeydown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit(e);
        if (e.key === 'Escape') editing = false;
      }}
    />
  {:else}
    <button
      type="button"
      class="val"
      class:changed={value !== reset}
      onclick={() => (editing = true)}
      title="Click to type a value"
    >
      {shown}
    </button>
  {/if}
</div>

<style>
  .sl {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .lbl {
    color: var(--sl-text-faint);
    font-size: var(--sl-text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .track {
    position: relative;
    flex: 1;
    min-width: 40px;
    height: 16px;
    cursor: ew-resize;
    touch-action: none;
  }
  .track::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 7px;
    height: 2px;
    border-radius: 1px;
    background: var(--sl-surface-3);
  }
  .fill {
    position: absolute;
    top: 7px;
    height: 2px;
    background: var(--sl-text-muted);
  }
  .thumb {
    position: absolute;
    top: 3px;
    width: 10px;
    height: 10px;
    margin-left: -5px;
    border-radius: 50%;
    background: var(--sl-text);
    box-shadow: 0 0 0 2px var(--sl-bg);
  }
  .track:focus-visible {
    outline: none;
  }
  .track:focus-visible .thumb {
    box-shadow: var(--sl-focus);
  }
  .val {
    width: 52px;
    height: 20px;
    padding: 0 4px;
    border: 1px solid transparent;
    border-radius: var(--sl-radius-sm);
    background: transparent;
    color: var(--sl-text-muted);
    font-family: var(--sl-font-mono);
    font-size: var(--sl-text-sm);
    text-align: right;
    cursor: text;
  }
  .val.changed {
    color: var(--sl-text);
  }
  input.val {
    border-color: var(--sl-border-strong);
    background: var(--sl-surface-1);
    color: var(--sl-text);
  }
</style>
