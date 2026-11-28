import { test, expect, type Page } from '@playwright/test';

const base = '/media/generated/';

async function setup(page: Page) {
  await page.goto('/');
  const gpu = await page.evaluate(
    async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  // In CI a missing adapter is a broken setup, not a reason to skip (it once hid every test).
  if (process.env.CI) expect(gpu, 'WebGPU adapter in CI').toBe(true);
  else test.skip(!gpu, 'WebGPU adapter not available in this browser');
  await page.waitForFunction(() => (globalThis as any).scenegrade);
}

/** Loads media through the demo's controller and waits for the first frame. */
async function load(page: Page, input: unknown) {
  return page.evaluate(async (i) => {
    const c = (globalThis as any).scenegrade;
    const info = await c.load(i);
    // Wait for the first frame on the GPU (software WebGPU in CI is slow).
    const cv = document.querySelector('.sg-player canvas') as HTMLCanvasElement;
    const cx = Math.floor(cv.width / 2);
    const cy = Math.floor(cv.height / 2);
    for (let t = 0; t < 200 && !(await c.player.probe(cx, cy)); t++)
      await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 200));
    return { name: info.name, frames: info.frameCount, codec: info.codec, error: c.state.error };
  }, input);
}

test('EXR: decoded scene value and on-screen pixel match the OCIO reference', async ({ page }) => {
  await setup(page);
  const r = await load(page, `${base}exr/chart_zip.exr`);
  expect(r.error).toBeNull();
  const res = await page.evaluate(async () => {
    const c = (globalThis as any).scenegrade;
    const core = (globalThis as any).scenegradeCore;
    const p = c.player;
    p.zoomTo(1, { x: 0, y: 0 });
    p.panBy(-p.state.view.panX, -p.state.view.panY); // image pixel (x,y) == canvas pixel (x,y)
    await new Promise((r) => setTimeout(r, 300));
    // 18% grey patch of the chart (see media manifest).
    const probe = await p.probe(960, 162);
    const lut = await core.color.loadViewLut('srgb-aces2-sdr709');
    const expected = core.color.applyViewCPU(lut, probe.scene);
    const blob: Blob = await p.snapshot();
    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const px = Array.from(ctx.getImageData(960, 162, 1, 1).data)
      .slice(0, 3)
      .map((v) => v / 255);
    return { scene: probe.scene, expected, px };
  });
  for (const v of res.scene) expect(v).toBeCloseTo(0.18, 3);
  for (let i = 0; i < 3; i++) expect(Math.abs(res.px[i] - res.expected[i])).toBeLessThan(2.5 / 255);
});

test('ProRes 422 HQ (ACEScct) decodes 10-bit and plays in real time', async ({ page }) => {
  await setup(page);
  const r = await load(page, `${base}video/chart_acescct_prores422hq.mov`);
  expect(r.codec).toBe('prores');
  const s = await page.evaluate(async () => {
    const c = (globalThis as any).scenegrade;
    c.update({ inputSpace: 'acescct' });
    c.player.play();
    await new Promise((r) => setTimeout(r, 3000));
    const gpu = { ...(c.player.renderer.timer?.ms ?? {}), total: c.state.stats.gpuMs };
    const hasTimer = !!c.player.renderer.timer;
    c.player.pause();
    const p = c.player;
    p.seek(0);
    await new Promise((r) => setTimeout(r, 400));
    p.zoomTo(1, { x: 0, y: 0 });
    p.panBy(-p.state.view.panX, -p.state.view.panY);
    await new Promise((r) => setTimeout(r, 200));
    const probe = await p.probe(960, 162);
    return {
      fps: c.state.stats.fps,
      gpu,
      hasTimer,
      fmt: c.state.media.pixelFormat,
      scene: probe.scene,
      error: c.state.error,
    };
  });
  expect(s.error).toBeNull();
  expect(s.fmt).toBe('I422P10');
  // Real-time playback is only meaningful on a hardware GPU (CI uses SwiftShader).
  if (!process.env.PW_CHROMIUM) expect(s.fps).toBeGreaterThan(20);
  // GPU timing reaches the stats when timestamp queries are available.
  if (s.hasTimer) expect(s.gpu.total).toBeGreaterThan(0);
  console.log('ProRes 1080p GPU ms', JSON.stringify(s.gpu));
  // The encoder (ffmpeg swscale) stored the 18% patch as Y' code 428 (ideal 426.3):
  // ACEScct (428 - 64) / 876 -> linear 0.184284. The player must decode that exactly.
  for (const v of s.scene) expect(Math.abs(v - 0.184284) / 0.184284).toBeLessThan(0.002);
});

test('EXR sequence, multilayer and every compression load without errors', async ({ page }) => {
  await setup(page);
  const files = [
    'none',
    'rle',
    'zips',
    'zip',
    'piz',
    'pxr24',
    'b44',
    'b44a',
    'dwaa',
    'dwab',
    'htj2k256',
    'htj2k32',
  ];
  for (const f of files) {
    const r = await load(page, `${base}exr/chart_${f}.exr`);
    expect(r.error, f).toBeNull();
  }
  const seq = await load(page, { url: `${base}exr/seq/chart.####.exr`, first: 1001, last: 1048 });
  expect(seq.frames).toBe(48);
  const ml = await page.evaluate(async (u) => {
    const c = (globalThis as any).scenegrade;
    const info = await c.load(u);
    c.player.setLayer(info.layers[1].name);
    await new Promise((r) => setTimeout(r, 500));
    return { layers: info.layers.map((l: any) => l.name), error: c.state.error };
  }, `${base}exr/multilayer.exr`);
  expect(ml.layers.length).toBeGreaterThan(2);
  expect(ml.error).toBeNull();
});

test('scopes, overlays and compare render without WebGPU validation errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await setup(page);
  await load(page, `${base}exr/nan_inf_half.exr`);
  const hist = await page.evaluate(async (b) => {
    const c = (globalThis as any).scenegrade;
    c.update({
      falseColor: 'stops',
      zebra: { high: true, low: true },
      clipping: { over: true, under: true, nan: true },
      peaking: { enabled: true },
    });
    await c.player.loadCompare(b);
    for (const mode of ['wipe', 'side-by-side', 'difference', 'blend']) {
      c.update({ compare: { mode } });
      await new Promise((r) => setTimeout(r, 150));
    }
    c.update({ falseColor: 'ire', view: 'pq-aces2-hdr1000-p3' });
    await new Promise((r) => setTimeout(r, 400));
    return true;
  }, `${base}exr/chart_dwaa.exr`);
  expect(hist).toBe(true);
  expect(errors.filter((e) => /WebGPU|GPUValidation|scenegrade/.test(e))).toEqual([]);
});

test('grade: on-screen pixel matches the CPU reference; undo restores the image', async ({
  page,
}) => {
  await setup(page);
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const r = await load(page, `${base}exr/chart_zip.exr`);
  expect(r.error).toBeNull();
  const res = await page.evaluate(async () => {
    const c = (globalThis as any).scenegrade;
    const core = (globalThis as any).scenegradeCore;
    const p = c.player;
    p.zoomTo(1, { x: 0, y: 0 });
    p.panBy(-p.state.view.panX, -p.state.view.panY);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const pixel = async (x: number, y: number) => {
      await wait(250);
      const bmp = await createImageBitmap(await p.snapshot());
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      return Array.from(ctx.getImageData(x, y, 1, 1).data)
        .slice(0, 3)
        .map((v) => v / 255);
    };
    const before = await pixel(960, 162);
    p.setGrade({
      nodes: [
        {
          linear: { exposure: 0.5, temperature: 4800 },
          primaries: { contrast: 1.2, saturation: 1.3, lift: [0, 0, 0.02, 0] },
          curves: {
            y: [
              [0, 0.02],
              [0.5, 0.55],
              [1, 1],
            ],
            hueSat: [[0, -0.5]],
          },
        },
        { logWheels: { highlights: [0.02, 0, -0.02] }, mix: 0.7 },
      ],
    });
    const lut = await core.color.loadViewLut('srgb-aces2-sdr709');
    const out: { expected: number[]; px: number[] }[] = [];
    for (const [x, y] of [
      [960, 162],
      [300, 500],
      [700, 420],
    ]) {
      const probe = await p.probe(x, y);
      out.push({ expected: core.color.applyViewCPU(lut, probe.graded), px: await pixel(x, y) });
    }
    p.undo();
    const after = await pixel(960, 162);
    return { before, after, out, canUndo: p.state.canUndo };
  });
  for (const o of res.out) {
    for (let i = 0; i < 3; i++) expect(Math.abs(o.px[i] - o.expected[i])).toBeLessThan(2.5 / 255);
  }
  expect(res.out[0].px).not.toEqual(res.before);
  expect(res.after).toEqual(res.before);
  expect(res.canUndo).toBe(false);
  expect(errors.filter((e) => /WGSL|GPUValidation|Invalid/i.test(e))).toEqual([]);
});

test('grade panel: wheel, curve and node edits are undoable steps', async ({ page }) => {
  await setup(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await load(page, `${base}exr/chart_zip.exr`);
  await page.locator('.sg-player').focus();
  await page.keyboard.press('e');
  const gain = page.getByRole('slider', { name: 'Gain colour balance' });
  await expect(gain).toBeVisible();
  const box = (await gain.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++)
    await page.mouse.move(box.x + box.width / 2 - i * 5, box.y + box.height / 2 - i * 5);
  await page.mouse.up();
  await page.getByRole('slider', { name: 'Gain colour balance' }).press('ArrowRight');
  await page.getByRole('tab', { name: 'Curves' }).click();
  const curve = page.getByRole('application', { name: /Y curve/ });
  const cb = (await curve.boundingBox())!;
  await page.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height * 0.4);
  await page.mouse.up();
  await page.getByRole('button', { name: 'Add node after the selected one' }).click();
  const r = await page.evaluate(() => {
    const p = (globalThis as any).scenegrade.player;
    const g = p.getGrade();
    const out = {
      nodes: g.nodes.length,
      gain: g.nodes[0].primaries.gain,
      y: g.nodes[0].curves.y.length,
      undos: 0,
    };
    while (p.state.canUndo && out.undos < 20) {
      p.undo();
      out.undos++;
    }
    return {
      ...out,
      identity: (globalThis as any).scenegradeCore.grade.isIdentityGrade(p.getGrade()),
      after: p.getGrade().nodes.length,
    };
  });
  expect(r.nodes).toBe(2);
  expect(r.gain[0]).toBeGreaterThan(1);
  expect(r.y).toBe(3);
  // drag + arrow key on the wheel, curve add+drag, add node
  expect(r.undos).toBe(4);
  expect(r.identity).toBe(true);
  expect(r.after).toBe(1);
  expect(errors).toEqual([]);
});

test('compare with original: graded on the A side, untouched on the B side', async ({ page }) => {
  await setup(page);
  await load(page, `${base}exr/chart_zip.exr`);
  const r = await page.evaluate(async () => {
    const c = (globalThis as any).scenegrade;
    const p = c.player;
    p.zoomTo(1, { x: 0, y: 0 });
    p.panBy(-p.state.view.panX, -p.state.view.panY);
    const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
    const px = async (x: number, y: number) => {
      await wait(300);
      const bmp = await createImageBitmap(await p.snapshot());
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      return Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
    };
    const origR = await px(700, 162);
    p.setGrade({ nodes: [{ linear: { exposure: 1 }, primaries: { saturation: 0.5 } }] });
    const gradedL = await px(100, 162);
    const gradedR = await px(700, 162);
    p.setCompareOriginal(true);
    c.update({ compare: { ...c.settings.compare, mode: 'wipe', wipe: 0.2, angle: 0 } });
    const splitL = await px(100, 162);
    const splitR = await px(700, 162);
    const state = p.state.compareOriginal;
    p.setCompareOriginal(false);
    return { origR, gradedL, gradedR, splitL, splitR, state, mode: c.settings.compare.mode };
  });
  expect(r.state).toBe(true);
  expect(r.gradedR).not.toEqual(r.origR);
  expect(r.splitL).toEqual(r.gradedL);
  expect(r.splitR).toEqual(r.origR);
  expect(r.mode).toBe('off');
});
