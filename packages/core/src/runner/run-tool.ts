import { spawn as spawnProcess } from 'node:child_process';
import { basename, dirname } from 'node:path';
import type { ToolCommand, ToolManifest } from '@bildora/protocol';
import type { RegisteredTool } from '../registry/tool-registry.js';
import {
  ParameterError,
  batchCommandLine,
  isBatchFile,
  programCommandLine,
  renderArguments,
} from './command-line.js';
import type { ParameterValues } from './command-line.js';
import { LAUNCHER_FAILURES, defaultLauncherPath } from './launcher.js';
import { readEnv, resolveExecutable } from './resolve-executable.js';

const TERMINAL_COLUMNS = 120;
const TERMINAL_ROWS = 30;

export type RunFailureKind =
  | 'invalid-parameters'
  | 'program-not-found'
  | 'interpreter-not-found'
  | 'unsupported'
  | 'launcher'
  | 'exit-code';

export interface RunFailure {
  readonly kind: RunFailureKind;
  readonly message: string;
}

export type RunResult =
  | { readonly status: 'completed'; readonly exitCode: 0; readonly durationMs: number }
  | {
      readonly status: 'failed';
      /** Absent when the tool never ran, or when the launcher failed before it could report. */
      readonly exitCode?: number;
      readonly durationMs: number;
      readonly failure: RunFailure;
    }
  | { readonly status: 'cancelled'; readonly durationMs: number };

export interface RunOptions {
  readonly parameters?: ParameterValues;
  /** Working folder. Defaults to the program's own folder, which scripts often assume. */
  readonly cwd?: string;
  /** Raw terminal output, escape sequences included. Core keeps none of it. */
  readonly onOutput?: (data: string) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Where the launcher is. Packaged apps pass a path outside the ASAR. */
  readonly launcherPath?: string;
}

export type WindowRunOptions = Omit<RunOptions, 'onOutput'>;

export interface ToolRun {
  /** Settles when the tool has ended and all its output was delivered. It never rejects. */
  readonly result: Promise<RunResult>;
  /** Ends the tool and every process it started. Does nothing once the run is over. */
  cancel(): void;
}

interface PreparedRun {
  readonly commandLine: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
}

/** Reported instead of thrown past the runner, so `result` has one way to carry a failure. */
class RunPreparationError extends Error {
  readonly failure: RunFailure;

  constructor(failure: RunFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

/**
 * The tool's environment. `ELECTRON_RUN_AS_NODE` is meant for the CLI's own runtime: inherited, it
 * would silently change how any Electron-based tool starts.
 */
function toolEnvironment(env: RunOptions['env'] = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0].toUpperCase() !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
}

function commandOf(manifest: ToolManifest): ToolCommand {
  if (manifest.level === 2) {
    throw new RunPreparationError({
      kind: 'unsupported',
      message: 'Level 2 tools run through their panel, which this build cannot host yet',
    });
  }
  return manifest.run;
}

async function prepare(tool: RegisteredTool, options: RunOptions): Promise<PreparedRun> {
  const { manifest, directory } = tool;
  const command = commandOf(manifest);
  const env = toolEnvironment(options.env);
  const parameters = manifest.level === 0 ? [] : manifest.parameters;

  let args: string[];
  try {
    args = [...command.args, ...renderArguments(parameters, options.parameters ?? {})];
  } catch (error) {
    if (error instanceof ParameterError) {
      throw new RunPreparationError({ kind: 'invalid-parameters', message: error.message });
    }
    throw error;
  }

  const program = await resolveExecutable(command.program, { env, searchFirst: [directory] });
  if (program === undefined) {
    throw new RunPreparationError({
      kind: 'program-not-found',
      message: `Program "${command.program}" was not found`,
    });
  }

  const cwd = options.cwd ?? dirname(program);
  try {
    return { commandLine: await commandLineFor(manifest, program, args, env), cwd, env };
  } catch (error) {
    if (error instanceof ParameterError) {
      throw new RunPreparationError({ kind: 'invalid-parameters', message: error.message });
    }
    throw error;
  }
}

/** Arguments an interpreter needs before a script path. PowerShell treats a quoted one as text. */
export function scriptInterpreterArguments(interpreter: string): readonly string[] {
  return /^(?:powershell|pwsh)(?:\.exe)?$/i.test(basename(interpreter)) ? ['-File'] : [];
}

async function commandLineFor(
  manifest: ToolManifest,
  program: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<string> {
  if (manifest.interpreter !== undefined) {
    const interpreter = await resolveExecutable(manifest.interpreter, { env });
    if (interpreter === undefined) {
      throw new RunPreparationError({
        kind: 'interpreter-not-found',
        message: `Interpreter "${manifest.interpreter}" is not installed, or is not on PATH`,
      });
    }
    const leading = scriptInterpreterArguments(interpreter);
    return programCommandLine(interpreter, [...leading, program, ...args]);
  }
  if (isBatchFile(program)) {
    const commandInterpreter = readEnv(env, 'ComSpec') ?? (await resolveExecutable('cmd', { env }));
    if (commandInterpreter === undefined) {
      throw new RunPreparationError({
        kind: 'interpreter-not-found',
        message: 'cmd.exe was not found, and it is needed to run a batch file',
      });
    }
    return batchCommandLine(commandInterpreter, program, args);
  }
  return programCommandLine(program, args);
}

function resultOfExit(exitCode: number, durationMs: number): RunResult {
  if (exitCode === 0) {
    return { status: 'completed', exitCode, durationMs };
  }
  const launcherFailure = LAUNCHER_FAILURES[exitCode >>> 0];
  if (launcherFailure !== undefined) {
    return {
      status: 'failed',
      durationMs,
      failure: { kind: 'launcher', message: launcherFailure },
    };
  }
  return {
    status: 'failed',
    exitCode,
    durationMs,
    failure: { kind: 'exit-code', message: `The tool exited with code ${String(exitCode)}` },
  };
}

/** A launcher process that has started. Killing it closes the job, which ends the tree. */
interface StartedProcess {
  /** Settles with the launcher's exit code, once all output was delivered. */
  readonly exit: Promise<number>;
  kill(): void;
}

type ProcessStarter = (launcherPath: string, mode: string, run: PreparedRun) => StartedProcess;

/** Everything that happens around a process, whichever way it is shown to the user. */
function trackRun(
  tool: RegisteredTool,
  options: RunOptions,
  loadStarter: () => Promise<ProcessStarter>,
): ToolRun {
  const startedAt = performance.now();
  const elapsed = (): number => performance.now() - startedAt;
  let cancelled = false;
  let endProcess: (() => void) | undefined;
  // A function, because `cancel()` changes this during the waits below.
  const isCancelled = (): boolean => cancelled;

  async function execute(): Promise<RunResult> {
    const launcherPath = options.launcherPath ?? defaultLauncherPath();
    const prepared = await prepare(tool, options);
    if (process.platform !== 'win32') {
      throw new RunPreparationError({
        kind: 'unsupported',
        message: 'Running tools needs a process launcher, which only exists for Windows so far',
      });
    }
    const start = await loadStarter();
    if (isCancelled()) {
      return { status: 'cancelled', durationMs: elapsed() };
    }

    const started = start(launcherPath, tool.manifest.leftoverProcesses, prepared);
    endProcess = () => {
      started.kill();
    };
    const exitCode = await started.exit;
    endProcess = undefined;
    return isCancelled()
      ? { status: 'cancelled', durationMs: elapsed() }
      : resultOfExit(exitCode, elapsed());
  }

  const result = execute().catch((error: unknown): RunResult => {
    if (error instanceof RunPreparationError) {
      return { status: 'failed', durationMs: elapsed(), failure: error.failure };
    }
    return {
      status: 'failed',
      durationMs: elapsed(),
      failure: {
        kind: 'launcher',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  });

  return {
    result,
    cancel() {
      cancelled = true;
      try {
        endProcess?.();
      } catch {
        // The process ended on its own between the check and the kill.
      }
    },
  };
}

/**
 * Starts a tool as a separate process, under a PTY and inside a Job Object. Anything that stops the
 * tool from running, wrong parameters included, is reported through `result`.
 */
export function startRun(tool: RegisteredTool, options: RunOptions = {}): ToolRun {
  return trackRun(tool, options, async () => {
    // Loaded here, so that importing core does not load a native module nobody may need.
    const { spawn } = await import('node-pty');
    return (launcherPath, mode, prepared) => {
      const terminal = spawn(launcherPath, `${mode} ${prepared.commandLine}`, {
        cols: TERMINAL_COLUMNS,
        rows: TERMINAL_ROWS,
        cwd: prepared.cwd,
        env: prepared.env,
        useConpty: true,
      });
      terminal.onData((data) => options.onOutput?.(data));
      return {
        // On Windows this fires after node-pty has drained the output.
        exit: new Promise((resolve) => {
          terminal.onExit(({ exitCode }) => {
            resolve(exitCode);
          });
        }),
        // `pty.kill()` would miss detached children and print a stack trace when the console has
        // gone, so the launcher is killed instead.
        kill: () => {
          process.kill(terminal.pid);
        },
      };
    };
  });
}

/**
 * Starts a tool in a window of its own, with no output reaching Bildora: a console program gets its
 * own console, and a GUI program shows only its windows. The launcher stays hidden, tracks the exit
 * code and keeps the tree in a Job Object. It is detached because libuv puts every other child in
 * a kill-on-close job of its own, and the tool must outlive Bildora if the user leaves it open.
 */
export function startWindowRun(tool: RegisteredTool, options: WindowRunOptions = {}): ToolRun {
  return trackRun(tool, options, () =>
    Promise.resolve((launcherPath, mode, prepared) => {
      const launcher = spawnProcess(launcherPath, [mode, '--new-console', prepared.commandLine], {
        cwd: prepared.cwd,
        env: prepared.env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
      return {
        exit: new Promise((resolve, reject) => {
          launcher.once('error', reject);
          launcher.once('exit', (code) => {
            // No code means a signal ended it, so the tool did not finish cleanly.
            resolve(code ?? 1);
          });
        }),
        kill: () => {
          launcher.kill();
        },
      };
    }),
  );
}
