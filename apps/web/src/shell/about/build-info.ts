/**
 * What this build is (ADR-0017 §6): the build-time constants from vite.config.ts, typed,
 * plus what derives from them. The product name and the repository URL live here once, so
 * the rename pass (presentation spec §7) is one edit each.
 */

/** The product name shown in the About dialog and its palette command. */
export const PRODUCT_NAME = 'Recto';

/** The source repository; the release-notes URL derives from it. */
export const REPOSITORY_URL = 'https://github.com/ErenDenizK/recto';

/** The licence of the app's own code (SPDX identifier). */
export const LICENSE_ID = 'Apache-2.0';

export interface BuildInfo {
  /** Semantic version of the web package, e.g. "1.0.0-beta.0". */
  readonly version: string;
  /** Short SHA of the built commit, or "unknown". */
  readonly commit: string;
  /** Build time as an ISO 8601 string. */
  readonly buildDate: string;
  /** A pre-release ("Public beta"): the version has a pre-release part (`-`). */
  readonly isPreRelease: boolean;
  /** The GitHub release of exactly this version. */
  readonly releaseNotesUrl: string;
}

/** Semver puts a pre-release identifier after a hyphen ("1.0.0-beta.0"). */
export function isPreReleaseVersion(version: string): boolean {
  return version.includes('-');
}

/** Release tags are `v<version>` (spec presentation §5). */
export function releaseNotesUrl(version: string): string {
  return `${REPOSITORY_URL}/releases/tag/v${encodeURIComponent(version)}`;
}

/** Derives the full build info from the three injected values. */
export function makeBuildInfo(version: string, commit: string, buildDate: string): BuildInfo {
  return {
    version,
    commit,
    buildDate,
    isPreRelease: isPreReleaseVersion(version),
    releaseNotesUrl: releaseNotesUrl(version),
  };
}

/** This build. */
export const BUILD_INFO: BuildInfo = makeBuildInfo(__APP_VERSION__, __APP_COMMIT__, __BUILD_DATE__);
