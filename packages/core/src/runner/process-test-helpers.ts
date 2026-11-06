/** Tells whether a process exists. Signal 0 checks without touching it. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ends a process a test left behind, if it is still there. */
export function endProcess(pid: number): void {
  if (isAlive(pid)) {
    process.kill(pid);
  }
}

/** Waits for a condition, because the OS ends a tree shortly after, not at once. */
export async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Condition not met within ${String(timeoutMs)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
