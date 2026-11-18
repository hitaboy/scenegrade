import { test, expect, type Page } from '@playwright/test';

const base = '/media/generated/';

async function setup(page: Page) {
  await page.goto('/');
  const gpu = await page.evaluate(
    async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  test.skip(!gpu, 'WebGPU adapter not available in this browser');
  await page.waitForFunction(() => (globalThis as any).scenelinear);
}

/** Loads media through the demo's controller and waits for the first frame. */
async function load(page: Page, input: unknown) {
  return page.evaluate(async (i) => {
    const c = (globalThis as any).scenelinear;
    const info = await c.load(i);
    await new Promise((r) => setTimeout(r, 600));
    return { name: info.name, frames: info.frameCount, codec: info.codec, error: c.state.error };
  }, input);
}

test('EXR: decoded scene value and on-screen pixel match the OCIO reference', async ({ page }) => {
  await setup(page);
  const r = await load(page, `${base}exr/chart_zip.exr`);
  expect(r.error).toBeNull();
  const res = await page.evaluate(async () => {
    const c = (globalThis as any).scenelinear;
    const core = (globalThis as any).scenelinearCore;
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
    const c = (globalThis as any).scenelinear;
    c.update({ inputSpace: 'acescct' });
    c.player.play();
    await new Promise((r) => setTimeout(r, 3000));
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
      fmt: c.state.media.pixelFormat,
      scene: probe.scene,
      error: c.state.error,
    };
  });
  expect(s.error).toBeNull();
  expect(s.fmt).toBe('I422P10');
  expect(s.fps).toBeGreaterThan(20);
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
    const c = (globalThis as any).scenelinear;
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
    const c = (globalThis as any).scenelinear;
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
  expect(errors.filter((e) => /WebGPU|GPUValidation|scenelinear/.test(e))).toEqual([]);
});
