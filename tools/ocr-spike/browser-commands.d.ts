/** SPIKE S1 (M5): the custom browser command registered in vitest.config.ts. */
declare module 'vitest/browser' {
  interface BrowserCommands {
    /** Sum of VmRSS / VmHWM over Chromium renderer processes, MiB (Linux /proc). */
    rendererMemory: () => Promise<{ rssMiB: number; peakMiB: number }>;
    /** 1/5/15-minute load average and CPU of the host. */
    hostLoad: () => Promise<{ loadavg: number[]; cpus: number; cpu: string }>;
  }
}

export {};
