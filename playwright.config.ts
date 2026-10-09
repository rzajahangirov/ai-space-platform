import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: 'http://localhost:5174',
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node node_modules/tsx/dist/cli.mjs scripts/e2e-server.ts',
    url: 'http://localhost:5174',
    reuseExistingServer: false,
    timeout: 60000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    // Browser tests use deterministic local agents, never the developer's model credentials.
    env: { OPENAI_API_KEY: '' },
  },
  reporter: [['list']],
});
