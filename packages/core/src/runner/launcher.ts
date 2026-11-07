import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The launcher built by scripts/build-launcher.mjs. This path holds both from `src` under test
 * and from `dist`. In a packaged app it is unpacked, because Windows cannot run a file in an ASAR.
 */
export function defaultLauncherPath(): string {
  return fileURLToPath(new URL('../../dist/bin/job-launcher.exe', import.meta.url)).replace(
    `${sep}app.asar${sep}`,
    `${sep}app.asar.unpacked${sep}`,
  );
}

/** Failures of the launcher itself. Keep in sync with native/job-launcher.cpp. */
export const LAUNCHER_FAILURES: Readonly<Record<number, string>> = {
  0xb1d00001: 'The process launcher was called incorrectly',
  0xb1d00002: 'The process launcher could not set up a Job Object',
  0xb1d00003: 'The program could not be started',
  0xb1d00004: 'The program could not be placed in a Job Object',
};
