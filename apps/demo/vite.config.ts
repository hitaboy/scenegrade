import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  base: process.env.DEMO_BASE ?? '/',
  plugins: [svelte()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@scenelinear/core', '@scenelinear/exr-wasm', '@scenelinear/svelte', '@mediabunny/prores', 'turbores'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: { port: 5199, fs: { allow: ['../..'] } },
});
