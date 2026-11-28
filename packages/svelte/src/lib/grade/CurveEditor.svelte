<script lang="ts">
  /**
   * Curve editor.
   * - Click empty space: add a point (and drag it). Drag a point to move it.
   * - Double-click or Alt+click a point: remove it. Arrow keys move the selected point.
   * kind 'tone'     : x, y in [0, 1] (ACEScct), identity diagonal.
   * kind 'periodic' : hue on x (wraps), delta on y with a neutral line at 0.
   * kind 'delta'    : x in [0, 1], delta on y.
   */
  import { grade as G } from '@scenegrade/core';

  type Pts = [number, number][];
  let {
    points,
    kind,
    yMin = 0,
    yMax = 1,
    stroke = 'var(--sg-text)',
    background = 'none',
    label,
    onchange,
    onbegin,
    oncommit,
  }: {
    points: Pts;
    kind: 'tone' | 'periodic' | 'delta';
    yMin?: number;
    yMax?: number;
    stroke?: string;
    background?: 'none' | 'hue' | 'luma';
    label: string;
    onchange: (p: Pts) => void;
    /** Pointer down: a gesture starts (one undo step until `oncommit`). */
    onbegin?: () => void;
    oncommit?: () => void;
  } = $props();

  let w = $state(300);
  let h = $state(200);
  let svg: SVGSVGElement;
  let drag = $state(-1);
  let sel = $state(-1);
  const PAD = 6;

  const sx = (x: number) => PAD + x * (w - 2 * PAD);
  const sy = (y: number) => PAD + (1 - (y - yMin) / (yMax - yMin)) * (h - 2 * PAD);
  const ix = (px: number) => (px - PAD) / (w - 2 * PAD);
  const iy = (py: number) => yMin + (1 - (py - PAD) / (h - 2 * PAD)) * (yMax - yMin);
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

  const fn = $derived(
    kind === 'periodic'
      ? G.makePeriodicSpline(points)
      : G.makeSpline(points, kind === 'tone' ? 'offset' : 'flat'),
  );
  const path = $derived.by(() => {
    const n = 160;
    let d = '';
    for (let i = 0; i <= n; i++) {
      const x = i / n;
      const y = kind === 'tone' && points.length === 0 ? x : fn(x);
      d += `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(clamp(y, yMin, yMax)).toFixed(1)}`;
    }
    return d;
  });
  const neutral = $derived(
    kind === 'tone'
      ? `M${sx(0)},${sy(0)}L${sx(1)},${sy(1)}`
      : `M${sx(0)},${sy(0)}L${sx(1)},${sy(0)}`,
  );
  const bg = $derived(
    background === 'hue'
      ? 'linear-gradient(90deg, #a55 0%, #aa5 16.7%, #5a5 33.3%, #5aa 50%, #55a 66.7%, #a5a 83.3%, #a55 100%)'
      : background === 'luma'
        ? 'linear-gradient(90deg, #111, #888)'
        : 'none',
  );

  function local(e: PointerEvent | MouseEvent) {
    const r = svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function hit(px: number, py: number) {
    let best = -1;
    let bd = 8;
    points.forEach(([x, y], i) => {
      const d = Math.hypot(sx(x) - px, sy(y) - py);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }
  function sorted(p: Pts, keep: number): { pts: Pts; idx: number } {
    const tagged = p.map((q, i) => ({ q, i }));
    tagged.sort((a, b) => a.q[0] - b.q[0]);
    return { pts: tagged.map((t) => t.q), idx: tagged.findIndex((t) => t.i === keep) };
  }
  function remove(i: number) {
    if (kind === 'tone' && points.length <= 2) return;
    const p = points.filter((_, k) => k !== i);
    sel = -1;
    onchange(p);
    oncommit?.();
  }
  function down(e: PointerEvent) {
    onbegin?.();
    const { x, y } = local(e);
    let i = hit(x, y);
    if (i >= 0 && e.altKey) {
      remove(i);
      return;
    }
    if (i < 0) {
      const nx = clamp(ix(x), 0, 1);
      let p: Pts;
      if (kind !== 'tone' && points.length === 0) {
        // Isolate the edit: two neutral anchors around the new point.
        const span = kind === 'periodic' ? 1 / 12 : 0.15;
        const a = kind === 'periodic' ? (nx - span + 1) % 1 : clamp(nx - span, 0, 1);
        const b = kind === 'periodic' ? (nx + span) % 1 : clamp(nx + span, 0, 1);
        p = [
          [a, 0],
          [nx, 0],
          [b, 0],
        ];
        const s = sorted(p, 1);
        p = s.pts;
        i = s.idx;
      } else {
        const ny = kind === 'tone' && points.length === 0 ? nx : fn(nx);
        const s = sorted([...points, [nx, clamp(ny, yMin, yMax)]], points.length);
        p = s.pts;
        i = s.idx;
      }
      onchange(p);
    }
    sel = i;
    drag = i;
    svg.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (drag < 0 || !svg.hasPointerCapture(e.pointerId)) return;
    const { x, y } = local(e);
    const p = points.map((q) => [q[0], q[1]] as [number, number]);
    let nx = ix(x);
    const ny = clamp(iy(y), yMin, yMax);
    if (kind === 'periodic') nx = ((nx % 1) + 1) % 1;
    else {
      const lo = drag > 0 ? p[drag - 1][0] + 1e-3 : 0;
      const hi = drag < p.length - 1 ? p[drag + 1][0] - 1e-3 : 1;
      nx = clamp(nx, lo, hi);
    }
    p[drag] = [nx, ny];
    if (kind === 'periodic') {
      const s = sorted(p, drag);
      drag = s.idx;
      sel = s.idx;
      onchange(s.pts);
    } else onchange(p);
  }
  function up() {
    oncommit?.(); // always: ends the gesture started on pointer down
    drag = -1;
  }
  function dbl(e: MouseEvent) {
    const { x, y } = local(e);
    const i = hit(x, y);
    if (i >= 0) remove(i);
  }
  function key(e: KeyboardEvent) {
    if (sel < 0 || sel >= points.length) return;
    const s = e.shiftKey ? 0.05 : 0.005;
    const dy = (yMax - yMin) * s;
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-s, 0],
      ArrowRight: [s, 0],
      ArrowUp: [0, dy],
      ArrowDown: [0, -dy],
    };
    if (e.key === 'Delete' || e.key === 'Backspace') {
      remove(sel);
    } else if (d[e.key]) {
      const p = points.map((q) => [q[0], q[1]] as [number, number]);
      const lo = kind === 'periodic' || sel === 0 ? 0 : p[sel - 1][0] + 1e-3;
      const hi = kind === 'periodic' || sel === p.length - 1 ? 1 : p[sel + 1][0] - 1e-3;
      p[sel] = [clamp(p[sel][0] + d[e.key][0], lo, hi), clamp(p[sel][1] + d[e.key][1], yMin, yMax)];
      onchange(p);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<div class="ce" bind:clientWidth={w} bind:clientHeight={h} style:background-image={bg}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <svg
    bind:this={svg}
    width={w}
    height={h}
    role="application"
    tabindex="0"
    aria-label="{label} curve: click to add a point, drag to move, double-click to remove"
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    ondblclick={dbl}
    onkeydown={key}
    onkeyup={() => oncommit?.()}
  >
    {#each [0.25, 0.5, 0.75] as g (g)}
      <line x1={sx(g)} x2={sx(g)} y1={PAD} y2={h - PAD} class="grid" />
      <line
        x1={PAD}
        x2={w - PAD}
        y1={sy(yMin + g * (yMax - yMin))}
        y2={sy(yMin + g * (yMax - yMin))}
        class="grid"
      />
    {/each}
    <path d={neutral} class="neutral" />
    <path d={path} class="curve" style:stroke />
    {#each points as [x, y], i (i)}
      <circle
        cx={sx(x)}
        cy={sy(clamp(y, yMin, yMax))}
        r={sel === i ? 4.5 : 3.5}
        class="pt"
        class:sel={sel === i}
      />
    {/each}
  </svg>
</div>

<style>
  .ce {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 120px;
    border: 1px solid var(--sg-border);
    border-radius: var(--sg-radius-sm);
    background-color: #141414;
    background-size: 100% 4px;
    background-repeat: no-repeat;
    background-position: bottom;
  }
  svg {
    position: absolute;
    inset: 0;
    display: block;
    cursor: crosshair;
    touch-action: none;
  }
  svg:focus-visible {
    outline: none;
    box-shadow: var(--sg-focus);
  }
  .grid {
    stroke: #262626;
    stroke-width: 1;
  }
  .neutral {
    fill: none;
    stroke: #3c3c3c;
    stroke-dasharray: 3 3;
  }
  .curve {
    fill: none;
    stroke-width: 1.5;
  }
  .pt {
    fill: var(--sg-bg);
    stroke: var(--sg-text);
    stroke-width: 1.5;
  }
  .pt.sel {
    fill: var(--sg-text);
  }
</style>
