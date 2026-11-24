import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Waits for the canvas of the automation on view to stop moving. Just after a tab opens, the
 * canvas frames the flow, which moves every block at once; on a slow machine that can land between
 * a test finding a block and clicking it, so the click hits whatever moved under the pointer.
 */
export async function canvasSettled(window: Page): Promise<void> {
  const viewport = window.locator('[role="tabpanel"]:visible .react-flow__viewport');
  const transform = () => viewport.getAttribute('style');
  await expect
    .poll(
      async () => {
        const before = await transform();
        await window.waitForTimeout(250);
        // Before it is framed, the canvas shows the flow from its origin.
        return (
          before?.includes('translate(0px, 0px) scale(1)') === false &&
          before === (await transform())
        );
      },
      // A large flow makes each look at the page slow, so a few take seconds.
      { message: 'the canvas should stop moving after it opens', timeout: 15_000 },
    )
    .toBe(true);
}
