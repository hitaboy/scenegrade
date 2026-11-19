<script lang="ts">
  export interface Option {
    value: string;
    label: string;
    group?: string;
  }
  let {
    value,
    options,
    label,
    onchange,
    width = 'auto',
    compact = false,
  }: {
    value: string;
    options: Option[];
    label: string;
    onchange: (v: string) => void;
    width?: string;
    compact?: boolean;
  } = $props();

  const groups = $derived.by(() => {
    const m = new Map<string, Option[]>();
    for (const o of options) {
      const g = o.group ?? '';
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(o);
    }
    return [...m.entries()];
  });
</script>

<label class="sel" class:compact style:width>
  <span class="lbl">{label}</span>
  <select {value} onchange={(e) => onchange((e.currentTarget as HTMLSelectElement).value)} aria-label={label}>
    {#each groups as [g, opts] (g)}
      {#if g}
        <optgroup label={g}>
          {#each opts as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
        </optgroup>
      {:else}
        {#each opts as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
      {/if}
    {/each}
  </select>
</label>

<style>
  .sel {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .lbl {
    color: var(--sg-text-faint);
    font-size: var(--sg-text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    white-space: nowrap;
  }
  .compact .lbl {
    display: none;
  }
  select {
    appearance: none;
    min-width: 0;
    width: 100%;
    height: var(--sg-control-h);
    padding: 0 22px 0 8px;
    border: 1px solid var(--sg-border);
    border-radius: var(--sg-radius-sm);
    background: var(--sg-surface-2)
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 16 16' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E")
      no-repeat right 7px center;
    color: var(--sg-text);
    font: inherit;
    font-size: var(--sg-text-sm);
    text-overflow: ellipsis;
    cursor: pointer;
  }
  select:hover {
    border-color: var(--sg-border-strong);
  }
  select:focus-visible {
    outline: none;
    box-shadow: var(--sg-focus);
  }
  option,
  optgroup {
    background: var(--sg-surface-2);
    color: var(--sg-text);
  }
</style>
