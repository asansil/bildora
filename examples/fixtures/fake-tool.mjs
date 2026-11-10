// A tool that misbehaves on request, for tests of process execution.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const [mode = 'exit', ...rest] = process.argv.slice(2);

function sleepForever() {
  setInterval(() => undefined, 1000);
}

/** Starts a child with no console and no link back to this process. */
function startDetachedChild() {
  const child = spawn(process.execPath, [self, 'sleep'], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

/** Writes one line and waits for it to leave, so a following exit cannot cut it off. */
function writeLine(text) {
  return new Promise((resolve) => {
    process.stdout.write(`${text}\n`, resolve);
  });
}

switch (mode) {
  case 'exit':
    process.exitCode = Number(rest[0] ?? 0);
    break;
  case 'args':
    await writeLine(`ARGS ${JSON.stringify(rest)}`);
    break;
  case 'lines':
    for (let line = 1; line <= Number(rest[0]); line += 1) {
      await writeLine(`LINE ${String(line)}`);
    }
    await writeLine('END');
    break;
  case 'hang':
    await writeLine('READY');
    sleepForever();
    break;
  case 'tree':
    await writeLine(`CHILD ${String(startDetachedChild())}`);
    sleepForever();
    break;
  case 'orphan':
    await writeLine(`CHILD ${String(startDetachedChild())}`);
    break;
  case 'sleep':
    sleepForever();
    break;
  case 'write': {
    // Writes <text> to <file>, for tests of the values a tool receives and the files it leaves.
    const [file, text = ''] = rest;
    writeFileSync(file, text);
    break;
  }
  case 'report': {
    // For tools with a window of their own, whose output cannot be read. `rest` is <file> <then>.
    const [file, then] = rest;
    const child = then === 'tree' || then === 'orphan' ? startDetachedChild() : undefined;
    writeFileSync(file, JSON.stringify({ pid: process.pid, child, tty: process.stdout.isTTY }));
    if (then === 'tree' || then === 'hang') {
      sleepForever();
    }
    break;
  }
  default:
    console.error(`Unknown mode: ${mode}`);
    process.exitCode = 64;
}
