import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
    // Tests never call real model providers; agents fall back to the deterministic local engine.
    env: { MODEL_API_KEY: '', OPENROUTER_API_KEY: '', OPENAI_API_KEY: '', LIVE_REVIEW: 'on' },
  },
});
