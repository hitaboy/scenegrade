<script lang="ts">
  /**
   * Colour wheel with a master thumbwheel (Resolve-style).
   * - Drag the disc: relative puck move (Shift = fine). Arrow keys nudge (Shift = ×10).
   * - Double-click the disc: reset colour. Double-click the thumbwheel: reset master.
   * - Drag the thumbwheel left/right (or scroll over the wheel) to change the master.
   */
  import { hueRingGradient, puckColor, puckToRgb, rgbToPuck, type RGB } from './wheel.js';

  let {
    label,
    rgb,
    master,
    range,
    masterReset = 0,
    masterMin = -1,
    masterMax = 1,
    masterStep = 0.001,
    readout,
    onrgb,
    onmaster,
    oncommit,
    size = 120,
  }: {
    label: string;
    /** Colour delta (zero luma). */
    rgb: RGB;
    master: number;
    /** Delta at the rim of the disc. */
    range: number;
    masterReset?: number;
    masterMin?: number;
    masterMax?: number;
    masterStep?: number;
    /** Effective per-channel values to print under the wheel. */
    readout: RGB;
    onrgb: (v: RGB) => void;
    onmaster: (v: number) => void;
    oncommit?: () => void;
    size?: number;
  } = $props();

  const ring = hueRingGradient();
  let disc: HTMLDivElement;
  let thumb: HTMLDivElement;
  let last: { x: number; y: number } | null = null;
  let lastThumb: number | null = null;
  let ticks = $state(0);

  const puck = $derived.by(() => {
    const [x, y] = rgbToPuck(rgb);
    let px = x / range;
    let py = y / range;
    const m = Math.hypot(px, py);
    if (m > 1) {
      px /= m;
      py /= m;
    }
    return { x: px, y: py };
  });
  const puckCss = $derived.by(() => {
    if (Math.hypot(puck.x, puck.y) < 1e-4) return 'var(--sl-text)';
    const c = puckColor(puck.x, puck.y);
    return `rgb(${c.map((v) => Math.round(v * 255)).join(' ')})`;
  });
  const changed = $derived(Math.hypot(puck.x, puck.y) > 1e-6);
  const masterChanged = $derived(master !== masterReset);

  function moveBy(dx: number, dy: number) {
    const [x, y] = rgbToPuck(rgb);
    onrgb(puckToRgb(x + dx, y + dy));
  }
  function down(e: PointerEvent) {
    disc.setPointerCapture(e.pointerId);
    last = { x: e.clientX, y: e.clientY };
  }
  function move(e: PointerEvent) {
    if (!last || !disc.hasPointerCapture(e.pointerId)) return;
    const r = size / 2;
    const sens = (e.shiftKey ? 0.15 : 1) * range;
    moveBy(((e.clientX - last.x) / r) * sens, (-(e.clientY - last.y) / r) * sens);
    last = { x: e.clientX, y: e.clientY };
  }
  function up() {
    last = null;
    oncommit?.();
  }
  function key(e: KeyboardEvent) {
    const s = (e.shiftKey ? 0.1 : 0.01) * range;
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-s, 0],
      ArrowRight: [s, 0],
      ArrowUp: [0, s],
      ArrowDown: [0, -s],
    };
    if (d[e.key]) {
      moveBy(...d[e.key]);
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      onrgb([0, 0, 0]);
      e.preventDefault();
      e.stopPropagation();
    }
  }
  const clampM = (v: number) =>
    Math.min(masterMax, Math.max(masterMin, Math.round(v / masterStep) * masterStep));
  function tdown(e: PointerEvent) {
    thumb.setPointerCapture(e.pointerId);
    lastThumb = e.clientX;
  }
  function tmove(e: PointerEvent) {
    if (lastThumb == null || !thumb.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - lastThumb;
    lastThumb = e.clientX;
    ticks += dx;
    const span = (masterMax - masterMin) / 400; // full range ≈ 400 px
    onmaster(clampM(master + dx * span * (e.shiftKey ? 0.15 : 1)));
  }
  function tup() {
    lastThumb = null;
    oncommit?.();
  }
  function wheel(e: WheelEvent) {
    e.preventDefault();
    const span = (masterMax - masterMin) / 200;
    onmaster(clampM(master - Math.sign(e.deltaY) * span * (e.shiftKey ? 0.15 : 1)));
    ticks -= Math.sign(e.deltaY) * 4;
  }
  function tkey(e: KeyboardEvent) {
    const s = (masterMax - masterMin) / (e.shiftKey ? 20 : 200);
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') onmaster(clampM(master + s));
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onmaster(clampM(master - s));
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  const fmt = (v: number) => (v >= 0 ? ' ' : '') + v.toFixed(3);
</script>

<div class="cw" style:--size="{size}px">
  <div class="head">
    <span class="lbl" class:changed={changed || masterChanged}>{label}</span>
    <button
      type="button"
      class="rst"
      title="Reset {label}"
      aria-label="Reset {label}"
      disabled={!changed && !masterChanged}
      onclick={() => {
        onrgb([0, 0, 0]);
        onmaster(masterReset);
        oncommit?.();
      }}
    >
      ↺
    </button>
  </div>
  <div
    class="disc"
    bind:this={disc}
    role="slider"
    tabindex="0"
    aria-label="{label} colour balance"
    aria-valuetext="x {puck.x.toFixed(2)}, y {puck.y.toFixed(2)}"
    aria-valuenow={Math.hypot(puck.x, puck.y)}
    title="Drag to balance (Shift: fine) · double-click to reset"
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onkeydown={key}
    onkeyup={() => oncommit?.()}
    onwheel={wheel}
    ondblclick={() => {
      onrgb([0, 0, 0]);
      oncommit?.();
    }}
  >
    <div class="ring" style:background={ring}></div>
    <div class="face"></div>
    <div class="cross"></div>
    <div
      class="puck"
      style:left="{50 + puck.x * 42}%"
      style:top="{50 - puck.y * 42}%"
      style:background={puckCss}
    ></div>
  </div>
  <div
    class="thumb"
    bind:this={thumb}
    role="slider"
    tabindex="0"
    aria-label="{label} master"
    aria-valuemin={masterMin}
    aria-valuemax={masterMax}
    aria-valuenow={master}
    title="Drag for master (Shift: fine) · double-click to reset"
    style:background-position-x="{ticks}px"
    onpointerdown={tdown}
    onpointermove={tmove}
    onpointerup={tup}
    onpointercancel={tup}
    onkeydown={tkey}
    onkeyup={() => oncommit?.()}
    ondblclick={() => {
      onmaster(masterReset);
      oncommit?.();
    }}
  ></div>
  <div class="vals" aria-hidden="true">
    <span class="r">{fmt(readout[0])}</span>
    <span class="g">{fmt(readout[1])}</span>
    <span class="b">{fmt(readout[2])}</span>
  </div>
</div>

<style>
  .cw {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    width: calc(var(--size) + 24px);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    width: 100%;
  }
  .lbl {
    color: var(--sl-text-faint);
    font-size: var(--sl-text-xs);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .lbl.changed {
    color: var(--sl-text);
  }
  .rst {
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--sl-text-faint);
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
  }
  .rst:disabled {
    visibility: hidden;
  }
  .rst:hover {
    color: var(--sl-text);
  }
  .disc {
    position: relative;
    width: var(--size);
    height: var(--size);
    border-radius: 50%;
    cursor: grab;
    touch-action: none;
  }
  .disc:active {
    cursor: grabbing;
  }
  .disc:focus-visible {
    outline: none;
    box-shadow: var(--sl-focus);
  }
  .ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    opacity: 0.55;
  }
  .face {
    position: absolute;
    inset: 5px;
    border-radius: 50%;
    background: radial-gradient(circle, #2a2a2a 0%, #222 70%, #1e1e1e 100%);
  }
  .cross {
    position: absolute;
    inset: 5px;
    border-radius: 50%;
    background:
      linear-gradient(var(--sl-border), var(--sl-border)) center / 1px 100% no-repeat,
      linear-gradient(var(--sl-border), var(--sl-border)) center / 100% 1px no-repeat;
    opacity: 0.6;
  }
  .puck {
    position: absolute;
    width: 10px;
    height: 10px;
    margin: -5px 0 0 -5px;
    border-radius: 50%;
    box-shadow:
      0 0 0 1.5px var(--sl-bg),
      0 0 0 2.5px var(--sl-text-muted);
    pointer-events: none;
  }
  .thumb {
    width: var(--size);
    height: 14px;
    border: 1px solid var(--sl-border);
    border-radius: var(--sl-radius-sm);
    background-color: var(--sl-surface-2);
    background-image: repeating-linear-gradient(
      90deg,
      var(--sl-border-strong) 0 1px,
      transparent 1px 6px
    );
    cursor: ew-resize;
    touch-action: none;
  }
  .thumb:focus-visible {
    outline: none;
    box-shadow: var(--sl-focus);
  }
  .vals {
    display: flex;
    gap: 6px;
    font-family: var(--sl-font-mono);
    font-size: var(--sl-text-xs);
    white-space: pre;
  }
  .r {
    color: #c98a8a;
  }
  .g {
    color: #8ac99a;
  }
  .b {
    color: #8aa4d9;
  }
</style>
