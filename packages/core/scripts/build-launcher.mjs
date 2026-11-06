// Compiles the Job Object launcher into dist/bin. It is Windows only, so elsewhere this does nothing.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { delimiter, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  console.error(
    `${message}\nInstall g++ (for example through MSYS2 UCRT64), or set BILDORA_CXX to its path.`,
  );
  process.exit(1);
}

/** Finds the compiler's full path, because its own DLLs must come first on PATH. */
function locate(compiler) {
  if (isAbsolute(compiler)) {
    return compiler;
  }
  const found = spawnSync('where', [compiler], { encoding: 'utf8' });
  const [first] = found.stdout?.split(/\r?\n/) ?? [];
  if (found.status !== 0 || first === undefined || first === '') {
    fail(`Could not find "${compiler}" to build the process launcher.`);
  }
  return first;
}

if (process.platform === 'win32') {
  const compiler = locate(process.env.BILDORA_CXX ?? 'g++');
  const source = fileURLToPath(new URL('../native/job-launcher.cpp', import.meta.url));
  const directory = new URL('../dist/bin/', import.meta.url);
  const output = fileURLToPath(new URL('job-launcher.exe', directory));
  mkdirSync(directory, { recursive: true });

  // With another toolchain earlier on PATH, as in Git Bash, g++ exits 1 and prints nothing.
  const env = { ...process.env, PATH: `${dirname(compiler)}${delimiter}${process.env.PATH ?? ''}` };
  const result = spawnSync(
    compiler,
    ['-std=c++17', '-O2', '-Wall', '-Wextra', '-static', '-municode', source, '-o', output],
    { stdio: 'inherit', env },
  );
  if (result.error !== undefined) {
    fail(`Could not run "${compiler}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`"${compiler}" could not build the process launcher.`);
  }
}
