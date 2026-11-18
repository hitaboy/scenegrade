<script lang="ts">
  import type { PlayerController } from '../controller.svelte.js';
  import Section from './Section.svelte';
  let { ctl }: { ctl: PlayerController } = $props();
  const m = $derived(ctl.state.media);
  const fmt = (v: number[] | undefined, d = 4) =>
    v ? v.map((x) => (Number.isFinite(x) ? x.toFixed(d) : String(x))).join('  ') : '—';
  const p = $derived(ctl.probe);
</script>

<Section title="Pixel probe">
  {#if ctl.ui.tool !== 'probe'}
    <p class="hint">Enable the probe (P) and hover the image. Alt+click pins a sample.</p>
  {:else if p}
    <dl class="kv mono">
      <dt>Pixel</dt>
      <dd>{p.x}, {p.y}</dd>
      {#if p.source}<dt>File</dt>
        <dd>{fmt(p.source)}</dd>{/if}
      <dt>ACEScg</dt>
      <dd>{fmt(p.scene)}</dd>
      <dt>Alpha</dt>
      <dd>{p.alpha.toFixed(4)}</dd>
      <dt>Display</dt>
      <dd>
        {fmt(p.display, 3)}
        <span class="dim">
          ({fmt(
            p.display.map((v) => v * 1023),
            0,
          )})
        </span>
      </dd>
      <dt>Stops</dt>
      <dd>{p.stops > 0 ? '+' : ''}{p.stops.toFixed(2)} vs 18%</dd>
      {#if p.nits != null}<dt>Luminance</dt>
        <dd>{p.nits.toFixed(1)} nits</dd>{/if}
    </dl>
  {:else}
    <p class="hint">Hover the image…</p>
  {/if}
  <label class="radius">
    Sample area
    <select
      value={String(ctl.ui.probeRadius)}
      onchange={(e) =>
        (ctl.ui.probeRadius = parseInt((e.currentTarget as HTMLSelectElement).value, 10))}
    >
      <option value="0">1 px</option><option value="1">3×3</option><option value="2">
        5×5
      </option><option value="4">9×9</option>
    </select>
  </label>
  {#if ctl.probePinned.length}
    <table class="pins mono">
      <thead><tr><th>#</th><th>x,y</th><th>ACEScg</th><th>stops</th></tr></thead>
      <tbody>
        {#each ctl.probePinned as q, i (i)}
          <tr>
            <td>{i + 1}</td><td>{q.x},{q.y}</td><td>{fmt(q.scene, 3)}</td><td>
              {q.stops.toFixed(2)}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <button type="button" class="link" onclick={() => (ctl.probePinned = [])}>Clear samples</button>
  {/if}
</Section>

<Section title="Media">
  {#if m}
    <dl class="kv">
      <dt>Name</dt>
      <dd>{m.name}</dd>
      <dt>Type</dt>
      <dd>
        {m.kind}{m.kind !== 'image' ? ` · ${m.frameCount} frames @ ${m.fps.toFixed(3)} fps` : ''}
      </dd>
      <dt>Resolution</dt>
      <dd>
        {m.width} × {m.height}{m.pixelAspectRatio !== 1
          ? ` (PAR ${m.pixelAspectRatio.toFixed(3)})`
          : ''}
      </dd>
      <dt>Colour hint</dt>
      <dd>{m.colorHints.inputSpace ?? '—'} <span class="dim">{m.colorHints.reason ?? ''}</span></dd>
      {#each Object.entries(m.metadata) as [k, v] (k)}
        <dt>{k}</dt>
        <dd>{v}</dd>
      {/each}
    </dl>
  {:else}
    <p class="hint">No media loaded.</p>
  {/if}
</Section>

<style>
  .kv {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 3px 10px;
    margin: 0;
    font-size: var(--sl-text-sm);
  }
  dt {
    color: var(--sl-text-faint);
  }
  dd {
    margin: 0;
    color: var(--sl-text);
    overflow-wrap: anywhere;
  }
  .mono dd,
  .mono td {
    font-family: var(--sl-font-mono);
    font-size: var(--sl-text-xs);
  }
  .dim {
    color: var(--sl-text-faint);
  }
  .hint {
    margin: 0;
    color: var(--sl-text-faint);
    font-size: var(--sl-text-sm);
  }
  .radius {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    color: var(--sl-text-faint);
    font-size: var(--sl-text-xs);
  }
  .radius select {
    background: var(--sl-surface-2);
    color: var(--sl-text);
    border: 1px solid var(--sl-border);
    border-radius: var(--sl-radius-sm);
    font-size: var(--sl-text-xs);
  }
  .pins {
    width: 100%;
    margin-top: 8px;
    border-collapse: collapse;
    color: var(--sl-text);
  }
  .pins th {
    color: var(--sl-text-faint);
    font-weight: normal;
    text-align: left;
    font-size: var(--sl-text-xs);
  }
  .link {
    margin-top: 6px;
    border: 0;
    padding: 0;
    background: none;
    color: var(--sl-text-muted);
    font-size: var(--sl-text-xs);
    text-decoration: underline;
    cursor: pointer;
  }
</style>
