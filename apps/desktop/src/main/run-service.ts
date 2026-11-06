import { randomUUID } from 'node:crypto';
import type { RegisteredTool, RunResult, ToolRun } from '@bildora/core';
import type { RunView } from '../shared/ipc-contract.js';

type StartRun = (tool: RegisteredTool) => ToolRun;

function viewOfResult(runId: string, toolId: string, result: RunResult): RunView {
  const shared = { runId, toolId, durationMs: result.durationMs };
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
 * Tool runs this session knows about. State lives in memory only, until run history exists: every
 * run still going, plus the latest finished one of each tool.
 */
export class RunService {
  private readonly active = new Map<string, { run: ToolRun; view: RunView }>();
  private readonly lastFinished = new Map<string, RunView>();
  private readonly settled = new Set<Promise<void>>();
  private readonly startRun: StartRun;
  private readonly onChange: () => void;

  constructor(startRun: StartRun, onChange: () => void) {
    this.startRun = startRun;
    this.onChange = onChange;
  }

  start(tool: RegisteredTool): RunView {
    const runId = randomUUID();
    const toolId = tool.manifest.id;
    const view: RunView = { runId, toolId, status: 'running' };
    const run = this.startRun(tool);
    this.active.set(runId, { run, view });

    const settled = run.result.then((result) => {
      this.active.delete(runId);
      this.settled.delete(settled);
      this.lastFinished.set(toolId, viewOfResult(runId, toolId, result));
      this.onChange();
    });
    this.settled.add(settled);
    this.onChange();
    return view;
  }

  cancel(runId: string): void {
    this.active.get(runId)?.run.cancel();
  }

  /** Ends every run, and settles once all of them have reported. */
  async cancelAll(): Promise<void> {
    for (const { run } of this.active.values()) {
      run.cancel();
    }
    await Promise.all(this.settled);
  }

  isRunning(toolId: string): boolean {
    return [...this.active.values()].some(({ view }) => view.toolId === toolId);
  }

  get activeCount(): number {
    return this.active.size;
  }

  list(): readonly RunView[] {
    const running = [...this.active.values()].map(({ view }) => view);
    return [...running, ...this.lastFinished.values()];
  }

  /** Forgets a removed tool's result, so a new tool with its id does not inherit it. */
  forget(toolId: string): void {
    this.lastFinished.delete(toolId);
  }
}
