import { randomUUID } from 'node:crypto';
import { toolKey } from '@bildora/core';
import type { RegisteredTool, RunProgress, RunResult, ToolRun } from '@bildora/core';
import type { RunOutputView, RunRequest, RunView } from '../shared/ipc-contract.js';

/** Raw console output kept per run, for a console that opens after the run started. */
const OUTPUT_BUFFER_LIMIT = 2 * 1024 * 1024;
/** How often output and progress reach the shell. A chatty tool must not flood the page. */
const SHELL_UPDATE_MS = 33;

export interface RunContext {
  readonly runId: string;
  /** The Workspace that started the run, whatever the user switches to afterwards. */
  readonly workspaceId: string;
  readonly request: RunRequest;
  readonly onOutput: (data: string) => void;
  readonly onProgress: (progress: RunProgress) => void;
}

type StartRun = (tool: RegisteredTool, context: RunContext) => ToolRun | Promise<ToolRun>;
type OutputListener = (output: RunOutputView) => void;

/** The end of a run's output. It keeps whole chunks, so a terminal sequence is rarely cut. */
class OutputBuffer {
  private chunks: string[] = [];
  private size = 0;
  private pending = '';
  sequence = 0;

  add(data: string): void {
    this.pending += data;
  }

  /** Moves what arrived since last time into the buffer, and returns it. */
  drain(): string {
    const data = this.pending;
    if (data === '') {
      return data;
    }
    this.pending = '';
    this.sequence += 1;
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > OUTPUT_BUFFER_LIMIT && this.chunks.length > 1) {
      this.size -= this.chunks.shift()?.length ?? 0;
    }
    return data;
  }

  text(): string {
    return this.chunks.join('');
  }
}

interface ActiveRun {
  view: RunView;
  readonly level: number;
  readonly workspaceId: string;
  readonly toolScope: RegisteredTool['scope'];
  readonly output: OutputBuffer;
  run?: ToolRun;
  cancelRequested: boolean;
}

function viewOfResult({ runId, toolId, toolKey: key }: RunView, result: RunResult): RunView {
  const shared = { runId, toolId, toolKey: key, durationMs: result.durationMs };
  switch (result.status) {
    case 'completed':
      return { ...shared, status: 'completed', exitCode: result.exitCode };
    case 'cancelled':
      return { ...shared, status: 'cancelled' };
    case 'failed':
      return {
        ...shared,
        status: 'failed',
        failure: result.failure,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      };
  }
}

/**
 * Tool runs this session knows about, which is what the shell shows live: every run still going,
 * plus the latest finished one of each tool. What is kept for later is run history, in core.
 * Tools are told apart by key, because two Workspaces can hold tools with the same id.
 */
export class RunService {
  private readonly active = new Map<string, ActiveRun>();
  private readonly lastFinished = new Map<string, RunView>();
  private readonly finishedOutput = new Map<string, { runId: string; output: OutputBuffer }>();
  private readonly settled = new Set<Promise<void>>();
  private readonly startRun: StartRun;
  private readonly onChange: () => void;
  private readonly onOutput: OutputListener;
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private progressChanged = false;

  constructor(
    startRun: StartRun,
    onChange: () => void,
    onOutput: OutputListener = () => undefined,
  ) {
    this.startRun = startRun;
    this.onChange = onChange;
    this.onOutput = onOutput;
  }

  start(tool: RegisteredTool, workspaceId: string, request: RunRequest = {}): RunView {
    const runId = randomUUID();
    const key = toolKey(tool);
    const view: RunView = { runId, toolId: tool.manifest.id, toolKey: key, status: 'running' };
    const entry: ActiveRun = {
      view,
      level: tool.manifest.level,
      workspaceId,
      toolScope: tool.scope,
      output: new OutputBuffer(),
      cancelRequested: false,
    };
    this.active.set(runId, entry);

    const settled = this.follow(tool, entry, request).then((result) => {
      this.sendOutput(entry);
      this.active.delete(runId);
      this.settled.delete(settled);
      this.lastFinished.set(key, viewOfResult(view, result));
      this.finishedOutput.set(key, { runId, output: entry.output });
      this.onChange();
    });
    this.settled.add(settled);
    this.onChange();
    return view;
  }

  private async follow(
    tool: RegisteredTool,
    entry: ActiveRun,
    request: RunRequest,
  ): Promise<RunResult> {
    const { runId } = entry.view;
    try {
      const run = await this.startRun(tool, {
        runId,
        workspaceId: entry.workspaceId,
        request,
        onOutput: (data) => {
          entry.output.add(data);
          this.scheduleUpdate();
        },
        onProgress: (progress) => {
          entry.view = { ...entry.view, progress };
          this.progressChanged = true;
          this.scheduleUpdate();
        },
      });
      entry.run = run;
      if (entry.cancelRequested) {
        run.cancel();
      }
      return await run.result;
    } catch (error) {
      return {
        status: 'failed',
        durationMs: 0,
        failure: {
          kind: 'launcher',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private scheduleUpdate(): void {
    this.updateTimer ??= setTimeout(() => {
      this.updateTimer = undefined;
      for (const entry of this.active.values()) {
        this.sendOutput(entry);
      }
      if (this.progressChanged) {
        this.progressChanged = false;
        this.onChange();
      }
    }, SHELL_UPDATE_MS);
  }

  private sendOutput(entry: ActiveRun): void {
    const data = entry.output.drain();
    if (data !== '') {
      this.onOutput({ runId: entry.view.runId, data, sequence: entry.output.sequence });
    }
  }

  cancel(runId: string): void {
    const entry = this.active.get(runId);
    if (entry !== undefined) {
      entry.cancelRequested = true;
      entry.run?.cancel();
    }
  }

  write(runId: string, data: string): void {
    this.active.get(runId)?.run?.write(data);
  }

  resize(runId: string, columns: number, rows: number): void {
    this.active.get(runId)?.run?.resize(columns, rows);
  }

  /** What a run has written so far, for a console opening late. Later output has a higher sequence. */
  readOutput(runId: string): RunOutputView | undefined {
    const entry = this.active.get(runId);
    if (entry !== undefined) {
      this.sendOutput(entry);
      return { runId, data: entry.output.text(), sequence: entry.output.sequence };
    }
    for (const finished of this.finishedOutput.values()) {
      if (finished.runId === runId) {
        const { output } = finished;
        return { runId, data: output.text(), sequence: output.sequence };
      }
    }
    return undefined;
  }

  /** Ends every run, and settles once all of them have reported. */
  async cancelAll(): Promise<void> {
    for (const entry of this.active.keys()) {
      this.cancel(entry);
    }
    await Promise.all(this.settled);
  }

  /** Ends the runs that live inside Bildora's own console, which cannot outlive the app. */
  async cancelConsoleRuns(): Promise<void> {
    const consoles = [...this.active.entries()].filter(([, entry]) => entry.level !== 0);
    const left = this.settled.size - consoles.length;
    for (const [runId] of consoles) {
      this.cancel(runId);
    }
    while (this.settled.size > left) {
      await Promise.race(this.settled);
    }
  }

  isRunning(key: string): boolean {
    return [...this.active.values()].some(({ view }) => view.toolKey === key);
  }

  /** Whether a Workspace has a run going, or a tool of its own in a run started elsewhere. */
  isWorkspaceBusy(workspaceId: string): boolean {
    return [...this.active.values()].some(
      (entry) =>
        entry.workspaceId === workspaceId ||
        (entry.toolScope.kind === 'workspace' && entry.toolScope.workspaceId === workspaceId),
    );
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** Runs that end with Bildora, because they have no window of their own. */
  get consoleCount(): number {
    return [...this.active.values()].filter(({ level }) => level !== 0).length;
  }

  list(): readonly RunView[] {
    const running = [...this.active.values()].map(({ view }) => view);
    return [...running, ...this.lastFinished.values()];
  }

  /** Forgets a removed tool's result, so a new tool with its id does not inherit it. */
  forget(key: string): void {
    this.lastFinished.delete(key);
    this.finishedOutput.delete(key);
  }
}
