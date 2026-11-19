import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/**
 * Not Vite "lib" mode on purpose: lib mode inlines every `new URL(asset, import.meta.url)` as base64,
 * which would put ~8 MB of ACES LUTs and the WASM decoders into the JS. A plain ES build with a single
 * entry emits them as files next to the bundle and loads them on demand, relative to the module.
 */
export default defineConfig({
  base: './',
  plugins: [svelte({ compilerOptions: { customElement: true }, emitCss: false })],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    copyPublicDir: false,
    rollupOptions: {
      input: { 'scenegrade-player': 'src/index.ts' },
      preserveEntrySignatures: 'strict',
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
