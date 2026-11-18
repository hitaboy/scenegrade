<script lang="ts">
  import { ScenePlayer, type PlayerController } from '@scenelinear/svelte';
  import * as core from '@scenelinear/core';
  import { SAMPLES } from './samples';
  (globalThis as unknown as { scenelinearCore?: unknown }).scenelinearCore = core;

  let ctl = $state<PlayerController>();
  let current = $state('');
  const groups = [...new Set(SAMPLES.map((s) => s.group))];

  function open(id: string) {
    const s = SAMPLES.find((x) => x.id === id);
    if (!s || !ctl) return;
    current = id;
    ctl.load(s.input).catch(() => undefined);
    if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
  }
  const hash = location.hash.slice(1);
  $effect(() => {
    const onHash = () => open(location.hash.slice(1));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  });
  $effect(() => {
    // Handle for e2e tests and the console.
    (globalThis as unknown as { scenelinear?: unknown }).scenelinear = ctl;
  });
</script>

<div class="page">
  <header>
    <strong>scenelinear</strong>
    <span class="tag">ACES web player · WebGPU</span>
    <label>
      Sample
      <select value={current} onchange={(e) => open((e.currentTarget as HTMLSelectElement).value)}>
        <option value="" disabled>Choose test media…</option>
        {#each groups as g (g)}
          <optgroup label={g}>
            {#each SAMPLES.filter((s) => s.group === g) as s (s.id)}<option value={s.id}>
                {s.label}
              </option>{/each}
          </optgroup>
        {/each}
      </select>
    </label>
    <span class="grow"></span>
    <a href="https://github.com/hitaboy/scenelinear" target="_blank" rel="noreferrer">GitHub</a>
  </header>
  <main>
    <ScenePlayer bind:controller={ctl} onready={() => hash && open(hash)} />
  </main>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    height: 100%;
    font-family:
      ui-sans-serif,
      system-ui,
      -apple-system,
      sans-serif;
    color: #d6d6d6;
  }
  header {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 40px;
    padding: 0 12px;
    border-bottom: 1px solid #333;
    background: #121212;
    font-size: 12px;
  }
  strong {
    font-size: 13px;
    letter-spacing: 0.02em;
  }
  .tag {
    color: #808080;
  }
  label {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #808080;
  }
  select {
    height: 24px;
    background: #262626;
    color: #d6d6d6;
    border: 1px solid #3a3a3a;
    border-radius: 3px;
  }
  .grow {
    flex: 1;
  }
  a {
    color: #9a9a9a;
  }
  main {
    flex: 1;
    min-height: 0;
  }
</style>
