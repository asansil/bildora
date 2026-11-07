import type { RunStatus, RunView } from '../../shared/ipc-contract.js';

export type ToolState = RunStatus | 'idle';

export interface ToolRunSummary {
  readonly state: ToolState;
  /** Runs of this tool still going. */
  readonly running: readonly RunView[];
  /** The latest finished run, which stays visible while a new one runs. */
  readonly last?: RunView;
}

/** Reduces every run the app knows about to what one tool shows. */
export function summarizeRuns(runs: readonly RunView[], toolKey: string): ToolRunSummary {
  const own = runs.filter((run) => run.toolKey === toolKey);
  const running = own.filter((run) => run.status === 'running');
  const last = own.find((run) => run.status !== 'running');
  return {
    state: running.length > 0 ? 'running' : (last?.status ?? 'idle'),
    running,
    ...(last === undefined ? {} : { last }),
  };
}

export function countRunning(runs: readonly RunView[]): number {
  return runs.filter((run) => run.status === 'running').length;
}
