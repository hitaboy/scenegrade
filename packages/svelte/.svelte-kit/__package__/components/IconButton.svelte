<script lang="ts">
  import Icon from './Icon.svelte';
  let {
    icon,
    label,
    active = false,
    disabled = false,
    shortcut = '',
    onclick,
    size = 16,
    text = '',
  }: {
    icon: string;
    label: string;
    active?: boolean;
    disabled?: boolean;
    shortcut?: string;
    onclick?: (e: MouseEvent) => void;
    size?: number;
    text?: string;
  } = $props();
</script>

<button
  type="button"
  class="ib"
  class:active
  class:has-text={!!text}
  {disabled}
  aria-label={label}
  aria-pressed={active}
  title={shortcut ? `${label} (${shortcut})` : label}
  {onclick}
>
  <Icon name={icon} {size} />
  {#if text}<span>{text}</span>{/if}
</button>

<style>
  .ib {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 28px;
    height: 28px;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: var(--sl-radius);
    background: transparent;
    color: var(--sl-text-muted);
    font: inherit;
    font-size: var(--sl-text-sm);
    cursor: pointer;
  }
  .ib:hover:not(:disabled) {
    background: var(--sl-surface-3);
    color: var(--sl-text);
  }
  .ib:focus-visible {
    outline: none;
    box-shadow: var(--sl-focus);
  }
  .ib.active {
    background: var(--sl-accent-weak);
    border-color: color-mix(in srgb, var(--sl-accent) 40%, transparent);
    color: var(--sl-accent);
  }
  .ib:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
