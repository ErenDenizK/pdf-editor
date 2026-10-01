/**
 * Chromium flags for every browser the media tool launches (scenes and `encode`).
 *
 * Hermetic: Chromium's own background services (update checks, field trials) must not
 * reach the network either, so the only traffic is the app's, which lib/privacy.ts logs and
 * checks. A request event fires before DNS, so a stray app request still fails its scene.
 */
export const HERMETIC_ARGS = [
  '--no-proxy-server',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
] as const;
