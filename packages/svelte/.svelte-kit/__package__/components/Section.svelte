<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  let { title, open = $bindable(true), children, actions }: { title: string; open?: boolean; children: Snippet; actions?: Snippet } = $props();
</script>

<section class="sec">
  <header>
    <button type="button" class="hd" aria-expanded={open} onclick={() => (open = !open)}>
      <span class="chev" class:closed={!open}><Icon name="chevron" size={12} /></span>
      {title}
    </button>
    {#if actions}<div class="act">{@render actions()}</div>{/if}
  </header>
  {#if open}<div class="body">{@render children()}</div>{/if}
</section>

<style>
  .sec {
    border-bottom: 1px solid var(--sl-border);
  }
  header {
    display: flex;
    align-items: center;
    height: 30px;
    padding: 0 6px 0 4px;
  }
  .hd {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 4px;
    height: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: var(--sl-text-muted);
    font: inherit;
    font-size: var(--sl-text-xs);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
    text-align: left;
  }
  .hd:hover {
    color: var(--sl-text);
  }
  .hd:focus-visible {
    outline: none;
    box-shadow: var(--sl-focus);
  }
  .chev {
    transition: transform 0.12s;
  }
  .chev.closed {
    transform: rotate(-90deg);
  }
  .act {
    display: flex;
    gap: 2px;
  }
  .body {
    padding: 2px 10px 10px;
  }
</style>
