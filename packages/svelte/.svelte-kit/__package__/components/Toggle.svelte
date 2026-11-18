<script lang="ts">
  let { checked, label, onchange }: { checked: boolean; label: string; onchange: (v: boolean) => void } = $props();
</script>

<label class="tg">
  <input type="checkbox" {checked} onchange={(e) => onchange((e.currentTarget as HTMLInputElement).checked)} />
  <span class="box" aria-hidden="true"></span>
  <span>{label}</span>
</label>

<style>
  .tg {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--sl-text-muted);
    font-size: var(--sl-text-sm);
    cursor: pointer;
    user-select: none;
  }
  input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .box {
    width: 24px;
    height: 14px;
    border-radius: 7px;
    background: var(--sl-surface-3);
    position: relative;
    transition: background 0.12s;
  }
  .box::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--sl-text-muted);
    transition: transform 0.12s;
  }
  input:checked + .box {
    background: color-mix(in srgb, var(--sl-accent) 55%, var(--sl-surface-3));
  }
  input:checked + .box::after {
    transform: translateX(10px);
    background: var(--sl-text);
  }
  input:focus-visible + .box {
    box-shadow: var(--sl-focus);
  }
</style>
