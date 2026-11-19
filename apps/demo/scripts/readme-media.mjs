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

// 1. Hero: night pier, grade palette open, scopes.
await open('/media/local/moll_P2-nit.mov', 60);
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

// 4. A/B compare: day vs night of the same set-up (wipe), then side by side.
await open('/media/local/moll_P2-dia.mov', 40);
await ev(async () => {
  const c = globalThis.scenegrade;
  c.player.settingsB.inputSpace = 'acescct';
  await c.player.loadCompare('/media/local/moll_P2-nit.mov');
  c.update({ compare: { ...c.settings.compare, mode: 'wipe', wipe: 0.5 } });
  c.player.seek(40);
});
await sleep(1500);
for (let i = 0; i <= 30; i++) {
  const w = 0.5 + 0.35 * Math.sin((2 * Math.PI * i) / 30);
  await settings({ compare: { mode: 'wipe', wipe: w } });
  await shot(`wipe_${String(i).padStart(3, '0')}.png`);
}
await ev(() => globalThis.scenegrade.player.loadCompare(null));
await settings({ compare: { mode: 'off' } });

// 5. HSL: portrait, hue vs sat curve open.
await open('/media/local/moll_P5-dia.mov', 60);
await ui({ gradeOpen: true, gradeTab: 'curves' });
await setGrade({
  nodes: [
    {
      primaries: { contrast: 1.1 },
      curves: {
        y: [
          [0, 0],
          [0.35, 0.33],
          [0.65, 0.68],
          [1, 1],
        ],
      },
    },
  ],
});
await shot('curves.jpg');

await browser.close();
console.log('done', out);
