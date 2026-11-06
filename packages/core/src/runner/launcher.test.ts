import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LAUNCHER_FAILURES, defaultLauncherPath } from './launcher.js';
import { endProcess, isAlive, waitUntil } from './process-test-helpers.js';

const fakeTool = fileURLToPath(
  new URL('../../../../examples/fixtures/fake-tool.mjs', import.meta.url),
);
const node = `"${process.execPath}" "${fakeTool}"`;

function launch(commandLine: string): { status: number; stdout: string } {
  const result = spawnSync(defaultLauncherPath(), [commandLine], {
    windowsVerbatimArguments: true,
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { status: (result.status ?? -1) >>> 0, stdout: result.stdout };
}

function childOf(stdout: string): number {
  const pid = /CHILD (\d+)/.exec(stdout)?.[1];
  if (pid === undefined) {
    throw new Error(`No child in: ${stdout}`);
  }
  return Number(pid);
}

describe.skipIf(process.platform !== 'win32')('job-launcher', () => {
  it.each([0, 7, 255])('forwards exit code %i', (code) => {
    expect(launch(`end ${node} exit ${String(code)}`).status).toBe(code);
  });

  it('keeps the quoting of the command line', () => {
    const { stdout } = launch(`end ${node} args "a b" c`);
    expect(stdout).toContain('ARGS ["a b","c"]');
  });

  it('finds the command after a quoted launcher path and repeated blanks', () => {
    expect(launch(`end   ${node}   exit 3`).status).toBe(3);
  });

  it.each([
    ['no command', 'end', 0xb1d00001],
    ['no command after the console option', 'end --new-console', 0xb1d00001],
    ['an unknown mode', `stay ${node}`, 0xb1d00001],
    ['a missing program', 'end C:\\no\\such\\program.exe', 0xb1d00003],
  ])('reports %s with a reserved code', (_name, commandLine, code) => {
    const { status } = launch(commandLine);
    expect(status).toBe(code);
    expect(LAUNCHER_FAILURES[status]).toBeDefined();
  });

  it('ends a detached child when the tool exits in end mode', async () => {
    const child = childOf(launch(`end ${node} orphan`).stdout);
    try {
      await waitUntil(() => !isAlive(child));
    } finally {
      endProcess(child);
    }
  });

  it('forwards the exit code from a console of its own', () => {
    const { status, stdout } = launch(`end --new-console ${node} exit 7`);
    expect(status).toBe(7);
    expect(stdout).toBe('');
  });

  it('leaves a detached child running when the tool exits in keep mode', async () => {
    const child = childOf(launch(`keep ${node} orphan`).stdout);
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(isAlive(child)).toBe(true);
    } finally {
      endProcess(child);
    }
  });
});
