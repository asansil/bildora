#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runCli } from './run.js';

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

const result = runCli(process.argv.slice(2), readOwnVersion());
if (result.stdout !== undefined) {
  console.log(result.stdout);
}
if (result.stderr !== undefined) {
  console.error(result.stderr);
}
process.exitCode = result.exitCode;
