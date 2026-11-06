// Electron entry that runs a tool under a PTY with the built core. The runner is otherwise tested
// only under Node, whose ABI differs from Electron's. Usage: electron <this file> <result file>
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import { parseManifest, startRun } from '../../packages/core/dist/index.js';

const [resultFile] = process.argv.slice(2);
const fixtures = fileURLToPath(new URL('../../examples/fixtures/', import.meta.url));
const manifest = parseManifest(`
schemaVersion: 1
id: pty.check
name: PTY check
version: 1.0.0
level: 1
interpreter: node
run:
  program: fake-tool.mjs
  args: [args, one]
`);

// Not awaited at the top level: Electron only becomes ready once this module has finished loading.
void app.whenReady().then(async () => {
  let output = '';
  const result = await startRun(
    { manifest, directory: fixtures, scope: { kind: 'global' } },
    {
      onOutput: (data) => {
        output += data;
      },
    },
  ).result;
  writeFileSync(
    resultFile,
    JSON.stringify({ result, output, electron: process.versions.electron }),
  );
  app.exit(0);
});
