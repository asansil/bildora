#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { runCli } from './run.js';
import type { CliIo } from './run.js';

function readOwnVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (
    typeof manifest === 'object' &&
    manifest !== null &&
    'version' in manifest &&
    typeof manifest.version === 'string'
  ) {
    return manifest.version;
  }
  throw new Error('package.json has no version');
}

function waitForEnter(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin });
    const finish = (answered: boolean): void => {
      signal.removeEventListener('abort', onAbort);
      lines.removeAllListeners();
      lines.close();
      resolve(answered);
    };
    const onAbort = (): void => {
      finish(false);
    };
    signal.addEventListener('abort', onAbort);
    lines.once('line', () => {
      finish(true);
    });
    lines.once('close', () => {
      finish(false);
    });
  });
}

/** Waits for a stream to take what it was given: on Windows, writing to a pipe is asynchronous. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write('', () => {
      resolve();
    });
  });
}

const io: CliIo = {
  env: process.env,
  out: (line) => {
    console.log(line);
  },
  error: (line) => {
    console.error(line);
  },
  interactive: process.stdin.isTTY,
  waitForEnter,
  onInterrupt: (listener) => {
    process.on('SIGINT', listener);
    return () => {
      process.off('SIGINT', listener);
    };
  },
};

const result = await runCli(process.argv.slice(2), readOwnVersion(), io);
if (result.stdout !== undefined) {
  console.log(result.stdout);
}
if (result.stderr !== undefined) {
  console.error(result.stderr);
}
await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
// Handles left by node-pty would otherwise keep the process alive.
process.exit(result.exitCode);
