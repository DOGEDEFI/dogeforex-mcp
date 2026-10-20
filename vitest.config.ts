import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Live read-only smoke tests against the Chikyu testnet public RPC.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
