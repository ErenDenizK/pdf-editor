import { defineConfig } from 'vitest/config';

// Node half of spike S2: corpus run, openssl cross-checks, PKCS#12 matrix. Node 22 has the
// same WebCrypto (`globalThis.crypto.subtle`) that pkijs 3.4.1 picks up automatically.
export default defineConfig({
  test: {
    include: ['spikes/*.node.ts'],
    environment: 'node',
    globalSetup: ['src/node/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
  },
});
