// Captures the README screenshots and GIF frames from the running demo (pnpm dev, port 5199)
// in a real Chrome with WebGPU. Media: ACEScct ProRes masters in apps/demo/public/media/local/.
//   pnpm --filter @scenegrade/demo exec node scripts/readme-media.mjs <outDir>
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'readme-frames';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
});
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto('http://localhost:5199/');
await page.waitForFunction(() => globalThis.scenegrade?.player);

const sleep = (ms) => page.waitForTimeout(ms);
const ev = (fn, arg) => page.evaluate(fn, arg);
async function open(url, frame = 0) {
  await ev(
    async ({ url, frame }) => {
      const c = globalThis.scenegrade;
      await c.load(url);
      c.update({ inputSpace: 'acescct' });
      c.player.seek(frame);
      const cv = document.querySelector('.sg-player canvas');
      for (let t = 0; t < 100 && !(await c.player.probe(cv.width / 2, cv.height / 2)); t++)
        await new Promise((r) => setTimeout(r, 100));
    },
    { url, frame },
  );
  await sleep(900);
}
const player = () => page.locator('.sg-player');
async function shot(name, clip) {
  const box = clip ?? (await player().boundingBox());
  await sleep(350); // scopes refresh
  await page.screenshot({
    path: join(out, name),
    clip: box,
    type: name.endsWith('.jpg') ? 'jpeg' : 'png',
    quality: name.endsWith('.jpg') ? 92 : undefined,
  });
}
const setGrade = (g) => ev((g) => globalThis.scenegrade.player.setGrade(g, { history: false }), g);
const ui = (patch) => ev((p) => Object.assign(globalThis.scenegrade.ui, p), patch);
const settings = (patch) => ev((p) => globalThis.scenegrade.update(p), patch);

const LOOK = (t) => ({
  nodes: [
    {
      label: 'Balance',
      linear: { exposure: 0.3 * t, temperature: 6500 - 1100 * t },
      primaries: {
        contrast: 1 + 0.22 * t,
        saturation: 1 + 0.18 * t,
        gain: [1 + 0.05 * t, 1, 1 - 0.05 * t, 1],
      },
    },
    {
      label: 'Split tone',
      logWheels: {
        shadows: [-0.018 * t, 0.003 * t, 0.03 * t],
        highlights: [0.025 * t, 0.006 * t, -0.022 * t],
      },
    },
    {
      label: 'Curve',
      curves: {
        y: [
          [0, 0],
          [0.3, 0.3 - 0.025 * t],
          [0.62, 0.62 + 0.02 * t],
          [1, 1],
        ],
      },
    },
  ],
});

// 1. Hero: night forest, grade palette open, scopes.
await open('/media/local/bosc_P4-nit.mov', 70);
await ui({ gradeOpen: true, gradeTab: 'log', panelOpen: true, panelTab: 'scopes' });
await setGrade(LOOK(1));
await ev(() => (globalThis.scenegrade.ui.gradeNode = globalThis.scenegrade.grade.nodes[1].id));
await shot('hero.jpg');

// 2. Live grading GIF frames: neutral -> look, palette on Primaries of node 1.
await ev(() => (globalThis.scenegrade.ui.gradeNode = globalThis.scenegrade.grade.nodes[0].id));
await ui({ gradeTab: 'primaries' });
const N = 36;
for (let i = 0; i <= N; i++) {
  const t = 0.5 - 0.5 * Math.cos((Math.PI * i) / N);
  await setGrade(LOOK(t));
  await shot(`grade_${String(i).padStart(3, '0')}.png`);
}

// 3. Analysis tools on the forest shot (viewer + scopes, no palette).
await setGrade({ nodes: [{}] });
await ui({ gradeOpen: false });
await open('/media/local/bosc_P1-dia.mov', 50);
const tools = [
  ['tools_0_view.png', {}],
  ['tools_1_falsecolor.png', { falseColor: 'stops' }],
  ['tools_2_ire.png', { falseColor: 'ire' }],
  ['tools_3_zebra.png', { falseColor: 'off', zebra: { high: true, highThreshold: 70 } }],
  [
    'tools_4_clipping.png',
    { zebra: { high: false }, clipping: { over: true, under: true, nan: true } },
  ],
  [
    'tools_5_peaking.png',
    { clipping: { over: false, under: false, nan: false }, peaking: { enabled: true } },
  ],
];
for (const [name, patch] of tools) {
  await settings(patch);
  await shot(name);
}
await settings({ peaking: { enabled: false } });

// 4. Split: the same close-up, original (B) against graded (A), wipe moving.
await open('/media/local/casa_P5-nit.mov', 60);
await setGrade({
  nodes: [
    {
      label: 'Skin',
      linear: { exposure: 0.55, temperature: 6000 },
      primaries: { contrast: 1.06, saturation: 1.1, gain: [1.035, 1, 0.965, 1] },
    },
    {
      label: 'Night',
      logWheels: { shadows: [-0.02, 0.004, 0.032], highlights: [0.022, 0.006, -0.02] },
      curves: {
        y: [
          [0, 0.01],
          [0.3, 0.29],
          [0.62, 0.635],
          [1, 1],
        ],
      },
    },
  ],
});
await ev(() => {
  const c = globalThis.scenegrade;
  c.player.setCompareOriginal(true);
  c.update({ compare: { ...c.settings.compare, mode: 'wipe', wipe: 0.5, angle: 0 } });
});
await sleep(800);
await shot('split_still.png');
for (let i = 0; i <= 40; i++) {
  const w = 0.5 + 0.38 * Math.sin((2 * Math.PI * i) / 40);
  await settings({ compare: { mode: 'wipe', wipe: w } });
  await shot(`wipe_${String(i).padStart(3, '0')}.png`);
}
await ev(() => globalThis.scenegrade.player.setCompareOriginal(false));
await setGrade({ nodes: [{}] });

await browser.close();
console.log('done', out);
