// Reference flows from examples/flows, set up in a fresh data folder and run from the app or the
// command line, as a person who copied them would.
import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const FLOWS = resolve('examples/flows');
const CLI = resolve('apps/cli/dist/bin.js');

/** The automations folder of the default workspace of a data folder. */
export function automationsFolder(dataDir: string): string {
  return join(dataDir, 'workspaces', 'default', 'automations');
}

/** Creates a data folder with a default workspace, every sample tool and the given flows. */
export async function setUpFlows(dataDir: string, flows: readonly string[]): Promise<void> {
  const workspace = join(dataDir, 'workspaces', 'default');
  await mkdir(automationsFolder(dataDir), { recursive: true });
  await writeFile(join(workspace, 'workspace.yaml'), 'formatVersion: 1\nname: Default\n');
  await cp(join(FLOWS, 'tools'), join(dataDir, 'tools'), { recursive: true });
  for (const flow of flows) {
    for (const file of await readdir(join(FLOWS, flow))) {
      if (file.endsWith('.yaml')) {
        await cp(join(FLOWS, flow, file), join(automationsFolder(dataDir), file));
      }
    }
  }
}

export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The environment of this process without the variable that would turn Electron into Node. */
export function electronEnvironment(extra: Record<string, string>): Record<string, string> {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
  );
  return { ...Object.fromEntries(inherited), ...extra };
}

/**
 * Runs the built bildora command as the packaged one does: Electron's binary running as Node, so
 * native modules built for Electron load. Nobody is at the terminal.
 */
export function runCli(dataDir: string, args: readonly string[]): Promise<CliResult> {
  const electron = createRequire(resolve('apps/desktop/package.json'))('electron') as string;
  const child = spawn(electron, [CLI, ...args], {
    env: electronEnvironment({ BILDORA_DATA_DIR: dataDir, ELECTRON_RUN_AS_NODE: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', (status) => {
      done({ status, stdout, stderr });
    });
  });
}
