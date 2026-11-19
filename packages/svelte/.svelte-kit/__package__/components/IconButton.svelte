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
    border-radius: var(--sg-radius);
    background: transparent;
    color: var(--sg-text-muted);
    font: inherit;
    font-size: var(--sg-text-sm);
    cursor: pointer;
  }
  .ib:hover:not(:disabled) {
    background: var(--sg-surface-3);
    color: var(--sg-text);
  }
  .ib:focus-visible {
    outline: none;
    box-shadow: var(--sg-focus);
  }
  .ib.active {
    background: var(--sg-accent-weak);
    border-color: color-mix(in srgb, var(--sg-accent) 40%, transparent);
    color: var(--sg-accent);
  }
  .ib:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
