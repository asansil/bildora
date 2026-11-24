import { execFile } from 'node:child_process';
import type { ElectronApplication } from '@playwright/test';

/** How long an app gets to close by itself, and then to go once its processes are ended. */
const CLOSE_TIMEOUT_MS = 5_000;

/** Settles with whether `promise` settled within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((done) => {
    timer = setTimeout(() => {
      done(false);
    }, ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Ends a process with all it started. Ending Electron's main process alone leaves its helpers. */
function endTree(pid: number): Promise<void> {
  return new Promise((done) => {
    execFile('taskkill', ['/pid', String(pid), '/t', '/f'], () => {
      done();
    });
  });
}

/**
 * Closes the apps a test launched. An app with a run still going asks before it closes, and a test
 * that failed halfway can leave one like that, so an app that has not closed in time is ended.
 * Otherwise the hook and the worker's teardown run out of time, and the whole suite fails.
 */
export async function closeApps(apps: readonly ElectronApplication[]): Promise<void> {
  await Promise.all(
    apps.map(async (app) => {
      let pid: number | undefined;
      try {
        ({ pid } = app.process());
      } catch {
        // A test that closed its app itself has nothing left to close.
        return;
      }
      const closed = app.close().catch(() => undefined);
      if (await settlesWithin(closed, CLOSE_TIMEOUT_MS)) return;
      if (pid !== undefined) await endTree(pid);
      await settlesWithin(closed, CLOSE_TIMEOUT_MS);
    }),
  );
}
