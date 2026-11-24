import { test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

/**
 * On CI, each app a test launches records a Playwright trace, kept only when the test fails. The
 * CI workflow uploads it, so a failure seen only there can be stepped through afterwards.
 */
const TRACING = process.env['CI'] !== undefined;
const STOP_TIMEOUT_MS = 10_000;

export async function startTrace(app: ElectronApplication): Promise<void> {
  if (!TRACING) return;
  await app.context().tracing.start({ screenshots: true, snapshots: true });
}

/** Stops the traces of the apps a test launched, keeping them if it failed. Call it before closing them. */
export async function stopTraces(apps: readonly ElectronApplication[]): Promise<void> {
  if (!TRACING) return;
  const info = test.info();
  const failed = info.status !== info.expectedStatus;
  await Promise.all(
    apps.map((app, index) =>
      Promise.race([
        app
          .context()
          .tracing.stop(failed ? { path: info.outputPath(`trace-${String(index + 1)}.zip`) } : {})
          // An app the test closed itself has no trace left to stop.
          .catch(() => undefined),
        // An app that hangs must not hold up its own closing, and the hook's time with it.
        new Promise((done) => setTimeout(done, STOP_TIMEOUT_MS)),
      ]),
    ),
  );
}
