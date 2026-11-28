<script lang="ts">
  import { grade as G, type Grade } from '@scenegrade/core';
  import type { PlayerController } from '../controller.svelte.js';
  import Slider from '../components/Slider.svelte';
  import Toggle from '../components/Toggle.svelte';
  import IconButton from '../components/IconButton.svelte';
  import Select from '../components/Select.svelte';
  import ColorWheel from './ColorWheel.svelte';
  import CurveEditor from './CurveEditor.svelte';
  import type { RGB } from './wheel.js';

  let { ctl }: { ctl: PlayerController } = $props();

  const n = $derived(ctl.node);
  const g = $derived(ctl.grade);
  const begin = () => ctl.beginEdit();
  const commit = () => ctl.commitEdit();
  const LR = 0.2722287168;
  const LG = 0.6740817658;
  const LB = 0.0536895174;
  const luma = (c: readonly number[]) => LR * c[0] + LG * c[1] + LB * c[2];

  // ---- grade-level edits -------------------------------------------------------------------
  function setGrade(next: Grade) {
    ctl.player.setGrade(next);
  }
  function addNode() {
    const next = ctl.player.getGrade();
    const node = G.defaultNode(`Node ${next.nodes.length + 1}`);
    const at = next.nodes.findIndex((x) => x.id === n?.id);
    next.nodes.splice(at < 0 ? next.nodes.length : at + 1, 0, node);
    setGrade(next);
    ctl.ui.gradeNode = node.id;
  }
  function removeNode() {
    if (!n) return;
    const next = ctl.player.getGrade();
    const i = next.nodes.findIndex((x) => x.id === n.id);
    next.nodes.splice(i, 1);
    if (!next.nodes.length) next.nodes.push(G.defaultNode('Node 1'));
    setGrade(next);
    ctl.ui.gradeNode = next.nodes[Math.max(0, i - 1)].id;
  }
  function moveNode(d: -1 | 1) {
    if (!n) return;
    const next = ctl.player.getGrade();
    const i = next.nodes.findIndex((x) => x.id === n.id);
    const j = i + d;
    if (j < 0 || j >= next.nodes.length) return;
    [next.nodes[i], next.nodes[j]] = [next.nodes[j], next.nodes[i]];
    setGrade(next);
  }
  function resetNode() {
    if (!n) return;
    const next = ctl.player.getGrade();
    const i = next.nodes.findIndex((x) => x.id === n.id);
    next.nodes[i] = { ...G.defaultNode(n.label), id: n.id };
    setGrade(next);
  }
  let renaming = $state('');
  function rename(id: string, name: string) {
    renaming = '';
    const next = ctl.player.getGrade();
    const node = next.nodes.find((x) => x.id === id);
    if (!node || !name.trim() || node.label === name.trim()) return;
    node.label = name.trim();
    setGrade(next);
  }

  // ---- file I/O ---------------------------------------------------------------------------
  // Exports: project JSON (exact), ASC CDL (exact for a CDL node, otherwise fitted) and 3D .cube
  // (ACEScct in/out). The error of approximate exports is measured and shown.
  let fileInput: HTMLInputElement;
  let ioError = $state('');
  let ioNote = $state('');
  const exportOptions = [
    { value: '', label: 'Export…' },
    { value: 'json', label: 'Project (.json)' },
    { value: 'cc', label: 'ASC CDL (.cc)' },
    { value: 'ccc', label: 'ASC CDL collection (.ccc)' },
    { value: 'cdl', label: 'ASC CDL list (.cdl)' },
    { value: 'cube33', label: '3D LUT .cube (33)' },
    { value: 'cube65', label: '3D LUT .cube (65)' },
  ];
  const baseName = () => (ctl.state.media?.name ?? 'grade').replace(/\.[^.]+$/, '');
  function download(text: string, name: string, type: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const cv = (e: G.LookError) => `${e.maxCodeValues.toFixed(2)} code values (10-bit)`;
  // The menu is an action list: re-created after each pick so it shows "Export…" again.
  let exportCount = $state(0);
  function exportAs(kind: string) {
    if (!kind) return;
    exportCount++;
    const grade = ctl.player.getGrade();
    const name = baseName();
    ioError = '';
    if (kind === 'json') {
      download(G.gradeToJson(grade), `${name}.grade.json`, 'application/json');
      ioNote = '';
    } else if (kind === 'cc' || kind === 'ccc' || kind === 'cdl') {
      const r = G.gradeToCdl(grade);
      const description = [
        'Working space: ACEScct',
        r.exact ? 'Exact CDL' : `Fitted by scenegrade, max error ${cv(r.error)}`,
      ];
      const xml = G.writeCdl(r.cdl, { format: kind, id: name, description });
      download(xml, `${name}.${kind}`, 'application/xml');
      ioNote = r.exact
        ? 'CDL: exact (ACEScct).'
        : r.error.maxCodeValues < 0.01
          ? 'CDL: matches the grade (ACEScct, error < 0.01 code values).'
          : `CDL fitted to the grade (ACEScct): max error ${cv(r.error)}.`;
    } else {
      const size = kind === 'cube65' ? 65 : 33;
      const r = G.gradeToCube(grade, { size, title: name });
      download(r.text, `${name}_${size}.cube`, 'text/plain');
      ioNote = `.cube ${size}³ (ACEScct in/out): max interpolation error ${cv(r.error)}.`;
    }
  }
  async function load(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = '';
    if (!f) return;
    try {
      const text = await f.text();
      ioNote = '';
      if (/\.(cc|ccc|cdl)$/i.test(f.name)) {
        // CDLs are added as new nodes after the current ones (a .ccc can hold several).
        const next = ctl.player.getGrade();
        const added = G.parseCdl(text).map((c) => G.cdlNode(c.cdl, c.id));
        next.nodes.push(...added);
        setGrade(next);
        ctl.ui.gradeNode = added[added.length - 1].id;
        ioNote = `Imported ${added.length} CDL${added.length > 1 ? 's' : ''} as new node${added.length > 1 ? 's' : ''}.`;
      } else {
        ctl.player.setGrade(G.gradeFromJson(text));
        ctl.ui.gradeNode = '';
      }
      ioError = '';
    } catch (err) {
      ioError = (err as Error).message;
    }
  }

  // ---- wheels -----------------------------------------------------------------------------
  type W4 = 'lift' | 'gamma' | 'gain' | 'offset';
  const wheels: { k: W4; label: string; range: number; mMin: number; mMax: number }[] = [
    { k: 'lift', label: 'Lift', range: 0.1, mMin: -0.5, mMax: 0.5 },
    { k: 'gamma', label: 'Gamma', range: 0.5, mMin: -2, mMax: 2 },
    { k: 'gain', label: 'Gain', range: 0.25, mMin: 0, mMax: 4 },
    { k: 'offset', label: 'Offset', range: 0.1, mMin: -0.5, mMax: 0.5 },
  ];
  const mul = (k: W4) => k === 'gain';
  function wheelRgb(k: W4): RGB {
    const v = n!.primaries[k];
    return mul(k) ? [v[0] - 1, v[1] - 1, v[2] - 1] : [v[0], v[1], v[2]];
  }
  function wheelReadout(k: W4): RGB {
    const v = n!.primaries[k];
    return [0, 1, 2].map((i) => (mul(k) ? v[i] * v[3] : v[i] + v[3])) as RGB;
  }
  function setWheel(k: W4, c: RGB) {
    const v = n!.primaries[k];
    const rgb = mul(k) ? c.map((x) => 1 + x) : c;
    ctl.editNode({ primaries: { [k]: [rgb[0], rgb[1], rgb[2], v[3]] } }, `wheel:${k}`);
  }
  function setMaster(k: W4, m: number) {
    const v = n!.primaries[k];
    ctl.editNode({ primaries: { [k]: [v[0], v[1], v[2], m] } }, `master:${k}`);
  }

  type W3 = 'shadows' | 'midtones' | 'highlights';
  const logWheels: { k: W3; label: string }[] = [
    { k: 'shadows', label: 'Shadows' },
    { k: 'midtones', label: 'Midtones' },
    { k: 'highlights', label: 'Highlights' },
  ];
  function logRgb(k: W3): RGB {
    const v = n!.logWheels[k];
    const y = luma(v);
    return [v[0] - y, v[1] - y, v[2] - y];
  }
  function setLog(k: W3, c: RGB, m = luma(n!.logWheels[k])) {
    ctl.editNode({ logWheels: { [k]: [c[0] + m, c[1] + m, c[2] + m] } }, `log:${k}`);
  }

  // ---- curves -----------------------------------------------------------------------------
  let curveCh = $state<'y' | 'r' | 'g' | 'b'>('y');
  const chColor = { y: 'var(--sg-text)', r: '#d07a7a', g: '#7ac08a', b: '#7a9ad8' } as const;
  type H = 'hueHue' | 'hueSat' | 'hueLum' | 'lumSat' | 'satSat';
  let hsl = $state<H>('hueSat');
  const hslDefs: Record<
    H,
    { label: string; kind: 'periodic' | 'delta'; y: number; bg: 'hue' | 'luma' | 'none' }
  > = {
    hueHue: { label: 'Hue vs Hue', kind: 'periodic', y: 0.25, bg: 'hue' },
    hueSat: { label: 'Hue vs Sat', kind: 'periodic', y: 1, bg: 'hue' },
    hueLum: { label: 'Hue vs Lum', kind: 'periodic', y: 0.2, bg: 'hue' },
    lumSat: { label: 'Lum vs Sat', kind: 'delta', y: 1, bg: 'luma' },
    satSat: { label: 'Sat vs Sat', kind: 'delta', y: 1, bg: 'none' },
  };
  const IDENT: [number, number][] = [
    [0, 0],
    [1, 1],
  ];

  // ---- stills -----------------------------------------------------------------------------
  let grabbing = $state(false);
  async function grab() {
    grabbing = true;
    try {
      await ctl.grabStill();
    } finally {
      grabbing = false;
    }
  }

  const tabs = [
    ['primaries', 'Primaries'],
    ['log', 'Log'],
    ['curves', 'Curves'],
    ['hsl', 'HSL'],
    ['mixer', 'Mixer · CDL'],
  ] as const;
  const f3 = (v: number) => v.toFixed(3);
</script>

<input
  bind:this={fileInput}
  type="file"
  accept=".json,.cc,.ccc,.cdl,application/json"
  hidden
  onchange={load}
/>

<section class="gp" aria-label="Grade">
  <!-- Node strip -->
  <div class="bar">
    <div class="nodes" role="listbox" aria-label="Grade nodes">
      {#each g.nodes as node, i (node.id)}
        <div
          class="node"
          class:on={node.id === n?.id}
          class:off={!node.enabled}
          role="option"
          aria-selected={node.id === n?.id}
          tabindex="0"
          title="{node.label} · double-click to rename"
          onclick={() => (ctl.ui.gradeNode = node.id)}
          onkeydown={(e) => e.key === 'Enter' && (ctl.ui.gradeNode = node.id)}
          ondblclick={() => (renaming = node.id)}
        >
          <button
            type="button"
            class="dot"
            class:dim={!node.enabled}
            aria-label={node.enabled ? `Disable ${node.label}` : `Enable ${node.label}`}
            title={node.enabled ? 'Disable node' : 'Enable node'}
            onclick={(e) => {
              e.stopPropagation();
              ctl.player.updateGradeNode(node.id, { enabled: !node.enabled });
            }}
          ></button>
          <span class="num">{i + 1}</span>
          {#if renaming === node.id}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="rename"
              value={node.label}
              autofocus
              aria-label="Node name"
              onclick={(e) => e.stopPropagation()}
              onblur={(e) => rename(node.id, e.currentTarget.value)}
              onkeydown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') rename(node.id, e.currentTarget.value);
                if (e.key === 'Escape') renaming = '';
              }}
            />
          {:else}
            <span class="name">{node.label}</span>
          {/if}
          {#if !G.isIdentityNode(node)}<span class="mod" title="Modified">•</span>{/if}
        </div>
      {/each}
      <IconButton icon="plus" label="Add node after the selected one" size={14} onclick={addNode} />
    </div>
    <div class="nodeops">
      <IconButton icon="left" label="Move node left" size={14} onclick={() => moveNode(-1)} />
      <IconButton icon="right" label="Move node right" size={14} onclick={() => moveNode(1)} />
      <IconButton icon="reset" label="Reset node" size={14} onclick={resetNode} />
      <IconButton
        icon="trash"
        label="Delete node"
        size={14}
        onclick={removeNode}
        disabled={g.nodes.length <= 1 && !!n && G.isIdentityNode(n)}
      />
      {#if n}
        <Slider
          label="Mix"
          value={n.mix}
          min={0}
          max={1}
          step={0.01}
          reset={1}
          width="140px"
          onchange={(v) => ctl.editNode({ mix: v }, 'mix')}
        />
      {/if}
    </div>
    <span class="grow"></span>
    <div class="globalops">
      <Toggle
        checked={ctl.state.compareOriginal}
        label="Split"
        onchange={(v) => ctl.player.setCompareOriginal(v)}
      />
      <Toggle
        checked={!g.enabled}
        label="Bypass"
        onchange={(v) => setGrade({ ...ctl.player.getGrade(), enabled: !v })}
      />
      <IconButton
        icon="undo"
        label="Undo"
        shortcut="⌘Z"
        size={14}
        disabled={!ctl.state.canUndo}
        onclick={() => ctl.player.undo()}
      />
      <IconButton
        icon="redo"
        label="Redo"
        shortcut="⇧⌘Z"
        size={14}
        disabled={!ctl.state.canRedo}
        onclick={() => ctl.player.redo()}
      />
      {#key exportCount}
        <Select
          label="Export"
          compact
          value=""
          options={exportOptions}
          onchange={(v) => exportAs(v)}
        />
      {/key}
      <IconButton
        icon="open"
        label="Load grade (.json) or ASC CDL (.cc, .ccc, .cdl)"
        size={14}
        onclick={() => fileInput.click()}
      />
      <IconButton
        icon="close"
        label="Close grade panel"
        shortcut="E"
        size={14}
        onclick={() => (ctl.ui.gradeOpen = false)}
      />
    </div>
  </div>
  {#if ioError}<div class="err" role="alert">{ioError}</div>{/if}
  {#if ioNote && !ioError}<div class="note" role="status">{ioNote}</div>{/if}

  <div class="body">
    <div class="tabs" role="tablist" aria-orientation="vertical">
      {#each tabs as [id, label] (id)}
        <button
          type="button"
          role="tab"
          aria-selected={ctl.ui.gradeTab === id}
          class:on={ctl.ui.gradeTab === id}
          onclick={() => (ctl.ui.gradeTab = id)}
        >
          {label}
        </button>
      {/each}
    </div>

    <div class="content">
      {#if n}
        {#if ctl.ui.gradeTab === 'primaries'}
          <div class="row">
            <div class="wheels">
              {#each wheels as w (w.k)}
                <ColorWheel
                  label={w.label}
                  rgb={wheelRgb(w.k)}
                  master={n.primaries[w.k][3]}
                  masterReset={mul(w.k) ? 1 : 0}
                  masterMin={w.mMin}
                  masterMax={w.mMax}
                  range={w.range}
                  readout={wheelReadout(w.k)}
                  onrgb={(c) => setWheel(w.k, c)}
                  onmaster={(m) => setMaster(w.k, m)}
                  onbegin={begin}
                  oncommit={commit}
                />
              {/each}
            </div>
            <div class="sliders">
              <Slider
                label="Exposure"
                value={n.linear.exposure}
                min={-6}
                max={6}
                step={0.01}
                bipolar
                width="100%"
                onchange={(v) => ctl.editNode({ linear: { exposure: v } }, 'exposure')}
              />
              <Slider
                label="Temp"
                value={n.linear.temperature}
                min={2000}
                max={15000}
                step={10}
                reset={6500}
                digits={0}
                unit="K"
                width="100%"
                onchange={(v) => ctl.editNode({ linear: { temperature: v } }, 'temp')}
              />
              <Slider
                label="Tint"
                value={n.linear.tint}
                min={-1}
                max={1}
                step={0.01}
                bipolar
                width="100%"
                onchange={(v) => ctl.editNode({ linear: { tint: v } }, 'tint')}
              />
              <Slider
                label="Contrast"
                value={n.primaries.contrast}
                min={0}
                max={3}
                step={0.01}
                reset={1}
                width="100%"
                onchange={(v) => ctl.editNode({ primaries: { contrast: v } }, 'contrast')}
              />
              <Slider
                label="Pivot"
                value={n.primaries.pivot}
                min={0}
                max={1}
                step={0.001}
                reset={G.PIVOT_18}
                digits={3}
                width="100%"
                onchange={(v) => ctl.editNode({ primaries: { pivot: v } }, 'pivot')}
              />
              <Slider
                label="Sat"
                value={n.primaries.saturation}
                min={0}
                max={3}
                step={0.01}
                reset={1}
                width="100%"
                onchange={(v) => ctl.editNode({ primaries: { saturation: v } }, 'sat')}
              />
              <Slider
                label="Hue"
                value={n.primaries.hue * 360}
                min={-180}
                max={180}
                step={0.5}
                digits={1}
                unit="°"
                bipolar
                width="100%"
                onchange={(v) => ctl.editNode({ primaries: { hue: v / 360 } }, 'hue')}
              />
            </div>
          </div>
        {:else if ctl.ui.gradeTab === 'log'}
          <div class="row">
            <div class="wheels">
              {#each logWheels as w (w.k)}
                <ColorWheel
                  label={w.label}
                  rgb={logRgb(w.k)}
                  master={luma(n.logWheels[w.k])}
                  masterMin={-0.3}
                  masterMax={0.3}
                  range={0.1}
                  readout={n.logWheels[w.k]}
                  onrgb={(c) => setLog(w.k, c)}
                  onmaster={(m) => setLog(w.k, logRgb(w.k), m)}
                  onbegin={begin}
                  oncommit={commit}
                />
              {/each}
            </div>
            <div class="sliders">
              <Slider
                label="Low range"
                value={n.logWheels.lowRange}
                min={0}
                max={1}
                step={0.001}
                reset={0.333}
                digits={3}
                width="100%"
                onchange={(v) => ctl.editNode({ logWheels: { lowRange: v } }, 'lowRange')}
              />
              <Slider
                label="High range"
                value={n.logWheels.highRange}
                min={0}
                max={1}
                step={0.001}
                reset={0.55}
                digits={3}
                width="100%"
                onchange={(v) => ctl.editNode({ logWheels: { highRange: v } }, 'highRange')}
              />
              <p class="hint">Ranges are ACEScct values (18 % grey = 0.414).</p>
            </div>
          </div>
        {:else if ctl.ui.gradeTab === 'curves'}
          <div class="row">
            <div class="editor">
              <CurveEditor
                label={curveCh.toUpperCase()}
                kind="tone"
                points={n.curves[curveCh]}
                stroke={chColor[curveCh]}
                onchange={(p) => ctl.editNode({ curves: { [curveCh]: p } }, `curve:${curveCh}`)}
                onbegin={begin}
                oncommit={commit}
              />
            </div>
            <div class="side">
              <div class="seg" role="radiogroup" aria-label="Curve channel">
                {#each ['y', 'r', 'g', 'b'] as const as c (c)}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={curveCh === c}
                    class:on={curveCh === c}
                    style:color={curveCh === c ? chColor[c] : undefined}
                    onclick={() => (curveCh = c)}
                  >
                    {c.toUpperCase()}{#if !G.isIdentityRgbCurve(n.curves[c])}•{/if}
                  </button>
                {/each}
              </div>
              <button
                type="button"
                class="txt"
                onclick={() => ctl.editNode({ curves: { [curveCh]: IDENT } })}
              >
                Reset {curveCh.toUpperCase()}
              </button>
              <button
                type="button"
                class="txt"
                onclick={() => ctl.editNode({ curves: { y: IDENT, r: IDENT, g: IDENT, b: IDENT } })}
              >
                Reset all
              </button>
              <p class="hint">
                ACEScct domain. Click to add, drag to move, double-click to remove. Arrows nudge the
                selected point.
              </p>
            </div>
          </div>
        {:else if ctl.ui.gradeTab === 'hsl'}
          {@const d = hslDefs[hsl]}
          <div class="row">
            <div class="editor">
              <CurveEditor
                label={d.label}
                kind={d.kind}
                points={n.curves[hsl]}
                yMin={-d.y}
                yMax={d.y}
                background={d.bg}
                onchange={(p) => ctl.editNode({ curves: { [hsl]: p } }, `curve:${hsl}`)}
                onbegin={begin}
                oncommit={commit}
              />
            </div>
            <div class="side">
              <div class="seg col" role="radiogroup" aria-label="HSL curve">
                {#each Object.entries(hslDefs) as [k, v] (k)}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={hsl === k}
                    class:on={hsl === k}
                    onclick={() => (hsl = k as H)}
                  >
                    {v.label}{#if !G.isIdentityDeltaCurve(n.curves[k as H])}&nbsp;•{/if}
                  </button>
                {/each}
              </div>
              <button
                type="button"
                class="txt"
                onclick={() => ctl.editNode({ curves: { [hsl]: [] } })}
              >
                Reset curve
              </button>
            </div>
          </div>
        {:else if ctl.ui.gradeTab === 'mixer'}
          <div class="row">
            <div class="mixer">
              <span class="h">Channel mixer (ACEScg)</span>
              <div class="grid3">
                <span></span><span class="r">R in</span><span class="g">G in</span><span class="b">
                  B in
                </span>
                {#each ['R', 'G', 'B'] as out, r (out)}
                  <span class="lab">{out} out</span>
                  {#each [0, 1, 2] as c (c)}
                    <input
                      type="number"
                      step="0.01"
                      value={n.linear.mixer[r * 3 + c].toFixed(3)}
                      aria-label="{out} out from {['R', 'G', 'B'][c]} in"
                      onkeydown={(e) => e.stopPropagation()}
                      onchange={(e) => {
                        const m = [...n.linear.mixer];
                        m[r * 3 + c] = parseFloat((e.currentTarget as HTMLInputElement).value) || 0;
                        ctl.editNode({ linear: { mixer: m } });
                      }}
                    />
                  {/each}
                {/each}
              </div>
              <div class="mixops">
                <button
                  type="button"
                  class="txt"
                  onclick={() => ctl.editNode({ linear: { mixer: [1, 0, 0, 0, 1, 0, 0, 0, 1] } })}
                >
                  Reset
                </button>
                <button
                  type="button"
                  class="txt"
                  onclick={() =>
                    ctl.editNode({ linear: { mixer: [LR, LG, LB, LR, LG, LB, LR, LG, LB] } })}
                >
                  Monochrome
                </button>
              </div>
            </div>
            <div class="cdl">
              <Toggle
                checked={n.cdl.enabled}
                label="ASC CDL (ACEScct)"
                onchange={(v) => ctl.editNode({ cdl: { enabled: v } })}
              />
              {#each ['slope', 'offset', 'power'] as const as k (k)}
                <div class="cdlrow">
                  <span class="h">{k}</span>
                  {#each [0, 1, 2] as c (c)}
                    <Slider
                      label={['R', 'G', 'B'][c]}
                      value={n.cdl[k][c]}
                      min={k === 'offset' ? -0.5 : 0}
                      max={k === 'offset' ? 0.5 : 4}
                      step={0.001}
                      digits={3}
                      reset={k === 'offset' ? 0 : 1}
                      width="150px"
                      onchange={(v) => {
                        const a = [...n.cdl[k]] as [number, number, number];
                        a[c] = v;
                        ctl.editNode({ cdl: { enabled: true, [k]: a } }, `cdl:${k}${c}`);
                      }}
                    />
                  {/each}
                </div>
              {/each}
              <Slider
                label="Sat"
                value={n.cdl.saturation}
                min={0}
                max={4}
                step={0.001}
                digits={3}
                reset={1}
                width="200px"
                onchange={(v) => ctl.editNode({ cdl: { enabled: true, saturation: v } }, 'cdl:sat')}
              />
              <p class="hint mono">
                slope {n.cdl.slope.map(f3).join(' ')} · offset {n.cdl.offset.map(f3).join(' ')} · power
                {n.cdl.power.map(f3).join(' ')} · sat {f3(n.cdl.saturation)}
              </p>
            </div>
          </div>
        {/if}
      {/if}
    </div>

    <aside class="stills" aria-label="Stills">
      <div class="sh">
        <span>Stills</span>
        <IconButton
          icon="camera"
          label="Grab still (frame + grade)"
          size={14}
          disabled={!ctl.state.media || grabbing}
          onclick={grab}
        />
      </div>
      <div class="list">
        {#each ctl.stills as s (s.id)}
          <div class="still">
            <button
              type="button"
              class="thumb"
              title="{s.name} · click to apply its grade"
              onclick={() => {
                ctl.player.setGrade(s.grade);
                ctl.ui.gradeNode = '';
              }}
            >
              <img src={s.thumb} alt={s.name} />
            </button>
            <button
              type="button"
              class="del"
              aria-label="Delete still {s.name}"
              onclick={() => (ctl.stills = ctl.stills.filter((x) => x.id !== s.id))}
            >
              ×
            </button>
            <span class="cap">{s.frame}</span>
          </div>
        {:else}
          <p class="hint">Grab a still to keep the frame and its grade.</p>
        {/each}
      </div>
    </aside>
  </div>
</section>

<style>
  .gp {
    display: flex;
    flex-direction: column;
    height: var(--sg-grade-h, 300px);
    border-top: 1px solid var(--sg-border);
    background: var(--sg-surface-1);
    font-size: var(--sg-text-sm);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 34px;
    padding: 0 6px;
    border-bottom: 1px solid var(--sg-border);
    overflow-x: auto;
  }
  .nodes,
  .nodeops,
  .globalops {
    display: flex;
    align-items: center;
    gap: 3px;
  }
  .globalops {
    gap: 6px;
  }
  .node {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 8px 0 6px;
    border: 1px solid var(--sg-border);
    border-radius: var(--sg-radius-sm);
    background: var(--sg-surface-2);
    color: var(--sg-text-muted);
    white-space: nowrap;
    cursor: pointer;
  }
  .node.on {
    border-color: var(--sg-accent);
    color: var(--sg-text);
  }
  .node.off .name {
    text-decoration: line-through;
    opacity: 0.6;
  }
  .node:focus-visible {
    outline: none;
    box-shadow: var(--sg-focus);
  }
  .dot {
    width: 10px;
    height: 10px;
    padding: 0;
    border: 1px solid var(--sg-text-muted);
    border-radius: 50%;
    background: var(--sg-accent);
    cursor: pointer;
  }
  .dot.dim {
    background: transparent;
  }
  .rename {
    width: 90px;
    height: 18px;
    padding: 0 4px;
    border: 1px solid var(--sg-border-strong);
    border-radius: 2px;
    background: var(--sg-surface-1);
    color: var(--sg-text);
    font: inherit;
  }
  .num {
    color: var(--sg-text-faint);
    font-family: var(--sg-font-mono);
  }
  .mod {
    color: var(--sg-accent);
  }
  .grow {
    flex: 1;
  }
  .err {
    padding: 4px 10px;
    color: var(--sg-danger);
  }
  .note {
    padding: 4px 10px;
    color: var(--sg-text-muted);
    font-size: var(--sg-text-xs);
  }
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .tabs {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 96px;
    padding: 6px 4px;
    border-right: 1px solid var(--sg-border);
  }
  .tabs button {
    height: 26px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--sg-radius-sm);
    background: none;
    color: var(--sg-text-muted);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .tabs button.on {
    background: var(--sg-surface-3);
    color: var(--sg-text);
  }
  .tabs button:focus-visible,
  .seg button:focus-visible,
  .txt:focus-visible {
    outline: none;
    box-shadow: var(--sg-focus);
  }
  .content {
    flex: 1;
    min-width: 0;
    padding: 10px 12px;
    overflow: auto;
  }
  .row {
    display: flex;
    gap: 18px;
    height: 100%;
    min-height: 200px;
  }
  .wheels {
    display: flex;
    gap: 10px;
  }
  .sliders {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 220px;
    max-width: 320px;
    flex: 1;
  }
  .sliders :global(.lbl) {
    width: 64px;
  }
  .editor {
    flex: 1;
    min-width: 240px;
    max-width: 560px;
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 180px;
  }
  .seg {
    display: flex;
    gap: 2px;
  }
  .seg.col {
    flex-direction: column;
  }
  .seg button {
    flex: 1;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--sg-border);
    border-radius: var(--sg-radius-sm);
    background: none;
    color: var(--sg-text-muted);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .seg:not(.col) button {
    text-align: center;
    font-weight: 600;
  }
  .seg button.on {
    background: var(--sg-surface-3);
    color: var(--sg-text);
  }
  .txt {
    align-self: flex-start;
    padding: 3px 8px;
    border: 1px solid var(--sg-border);
    border-radius: var(--sg-radius-sm);
    background: var(--sg-surface-2);
    color: var(--sg-text-muted);
    font: inherit;
    cursor: pointer;
  }
  .txt:hover {
    color: var(--sg-text);
  }
  .hint {
    margin: 0;
    color: var(--sg-text-faint);
    font-size: var(--sg-text-xs);
    line-height: 1.4;
  }
  .mono {
    font-family: var(--sg-font-mono);
  }
  .h {
    color: var(--sg-text-faint);
    font-size: var(--sg-text-xs);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .mixer {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .grid3 {
    display: grid;
    grid-template-columns: 48px repeat(3, 64px);
    gap: 4px;
    align-items: center;
    font-size: var(--sg-text-xs);
  }
  .grid3 input {
    width: 64px;
    height: 22px;
    padding: 0 4px;
    border: 1px solid var(--sg-border);
    border-radius: var(--sg-radius-sm);
    background: var(--sg-surface-2);
    color: var(--sg-text);
    font: var(--sg-text-sm) var(--sg-font-mono);
    text-align: right;
  }
  .lab {
    color: var(--sg-text-faint);
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
  .mixops {
    display: flex;
    gap: 6px;
  }
  .cdl {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cdlrow {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .cdlrow .h {
    width: 44px;
  }
  .stills {
    display: flex;
    flex-direction: column;
    width: 150px;
    border-left: 1px solid var(--sg-border);
  }
  .sh {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 30px;
    padding: 0 4px 0 10px;
    color: var(--sg-text-faint);
    font-size: var(--sg-text-xs);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 8px 8px;
    overflow-y: auto;
  }
  .still {
    position: relative;
  }
  .thumb {
    display: block;
    width: 100%;
    padding: 0;
    border: 1px solid var(--sg-border);
    border-radius: var(--sg-radius-sm);
    background: #000;
    cursor: pointer;
  }
  .thumb:hover {
    border-color: var(--sg-accent);
  }
  .thumb img {
    display: block;
    width: 100%;
  }
  .del {
    position: absolute;
    right: 2px;
    top: 2px;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: var(--sg-radius-sm);
    background: rgba(0, 0, 0, 0.6);
    color: var(--sg-text);
    cursor: pointer;
    opacity: 0;
  }
  .still:hover .del,
  .del:focus-visible {
    opacity: 1;
  }
  .cap {
    position: absolute;
    left: 4px;
    bottom: 3px;
    padding: 0 3px;
    border-radius: 2px;
    background: rgba(0, 0, 0, 0.6);
    color: var(--sg-text-muted);
    font: var(--sg-text-xs) var(--sg-font-mono);
  }
  @media (max-width: 900px) {
    .stills {
      display: none;
    }
    .row {
      flex-wrap: wrap;
    }
  }
</style>
