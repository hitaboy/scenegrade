<script lang="ts">
  import { SHORTCUTS } from '../shortcuts.js';
  import IconButton from './IconButton.svelte';
  let { onclose }: { onclose: () => void } = $props();
  const groups = ['Playback', 'View', 'Analysis', 'Panels'] as const;
</script>

<div class="help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
  <header>
    <h2>Keyboard shortcuts</h2>
    <IconButton icon="close" label="Close" onclick={onclose} />
  </header>
  <div class="cols">
    {#each groups as g (g)}
      <section>
        <h3>{g}</h3>
        <dl>
          {#each SHORTCUTS.filter((s) => s.group === g) as s (s.keys)}
            <dt><kbd>{s.keys}</kbd></dt>
            <dd>{s.label}</dd>
          {/each}
        </dl>
      </section>
    {/each}
  </div>
</div>

<style>
  .help {
    position: absolute;
    inset: 24px;
    z-index: 10;
    overflow: auto;
    padding: 16px 20px;
    border: 1px solid var(--sg-border-strong);
    border-radius: 8px;
    background: color-mix(in srgb, var(--sg-surface-1) 96%, transparent);
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: var(--sg-text-lg);
    font-weight: 600;
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 16px 28px;
    margin-top: 12px;
  }
  h3 {
    margin: 0 0 6px;
    color: var(--sg-text-faint);
    font-size: var(--sg-text-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 5px 10px;
    margin: 0;
    font-size: var(--sg-text-sm);
  }
  dd {
    margin: 0;
    color: var(--sg-text-muted);
  }
  kbd {
    padding: 1px 5px;
    border: 1px solid var(--sg-border-strong);
    border-bottom-width: 2px;
    border-radius: 3px;
    color: var(--sg-text);
    font: var(--sg-text-xs) var(--sg-font-mono);
    white-space: nowrap;
  }
</style>
