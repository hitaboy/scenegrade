import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests in a real Chrome with WebGPU. Locally uses the installed Chrome (channel: 'chrome');
 * set PW_CHROMIUM=1 to use Playwright's Chromium instead (CI).
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5199',
    channel: process.env.PW_CHROMIUM ? undefined : 'chrome',
    headless: true,
    viewport: { width: 1400, height: 860 },
    launchOptions: {
      args:
        process.platform === 'darwin'
          ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist']
          : ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  webServer: {
    command: 'pnpm exec vite --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
