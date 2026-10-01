import { describe, expect, it } from 'vitest';

import {
  BUILD_INFO,
  isPreReleaseVersion,
  makeBuildInfo,
  releaseNotesUrl,
  REPOSITORY_URL,
} from './build-info';

describe('build info', () => {
  it('treats a version with a pre-release part as a pre-release', () => {
    expect(isPreReleaseVersion('1.0.0-beta.0')).toBe(true);
    expect(isPreReleaseVersion('2.3.1-rc.2')).toBe(true);
    expect(isPreReleaseVersion('1.0.0')).toBe(false);
    expect(isPreReleaseVersion('0.0.0')).toBe(false);
  });

  it('links the release notes of exactly this version', () => {
    expect(REPOSITORY_URL).toBe('https://github.com/ErenDenizK/recto');
    expect(releaseNotesUrl('1.0.0-beta.0')).toBe(
      'https://github.com/ErenDenizK/recto/releases/tag/v1.0.0-beta.0',
    );
    expect(releaseNotesUrl('1.2.3')).toBe(
      'https://github.com/ErenDenizK/recto/releases/tag/v1.2.3',
    );
  });

  it('derives the flags and URL from the injected values', () => {
    expect(makeBuildInfo('1.0.0-beta.0', 'abc1234', '2026-10-01T00:00:00.000Z')).toEqual({
      version: '1.0.0-beta.0',
      commit: 'abc1234',
      buildDate: '2026-10-01T00:00:00.000Z',
      isPreRelease: true,
      releaseNotesUrl: 'https://github.com/ErenDenizK/recto/releases/tag/v1.0.0-beta.0',
    });
    expect(makeBuildInfo('1.0.0', 'unknown', '2026-10-01T00:00:00.000Z').isPreRelease).toBe(false);
  });

  it('reads this build from the define constants', async () => {
    // The tests run through vite.config.ts, so the constants are the real build values.
    const pkg = (await import('../../../package.json')).default as { version: string };
    expect(BUILD_INFO.version).toBe(pkg.version);
    expect(BUILD_INFO.commit).toMatch(/^([0-9a-f]{7,}|unknown)$/);
    expect(Number.isNaN(Date.parse(BUILD_INFO.buildDate))).toBe(false);
  });
});
